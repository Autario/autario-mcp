// backend/mcp/tools-data.js
// OWNED BY Track A
// Data tools: discovery + query + stats primitives + dataset CRUD + ontology.
// Definitions (DATA_TOOLS) + handler (handleDataTool). Union assembled in tools.js.

const { callAPI, callWriteAPI, computeGroupedStats, fetch, API_BASE, authHeaders, hasWriteAuth, ser, FORMAT_PROP, TOKEN_PRECISION, AUTARIO_SOURCES, SEMANTICS_RULE } = require('./tools-common');

// Shared minimal-response convention (the LLM/GEO channel returns only what the
// question asks by DEFAULT; the full raw series only on explicit request). Each
// data/stats tool that the server now summarizes by default carries this `full`
// flag so an agent can opt into the heavy per-timepoint array when it actually
// needs to plot/export it. The server strips the array unless full is set and
// adds a token-cost warning when it returns it.
const FULL_FLAG_SCHEMA = {
    full: {
        type: 'boolean',
        description: 'Return the full raw time series (heavy, many tokens). Default false → you get only the summary/stats, which is enough to ANSWER a question. Set true only when you must plot or export every point.',
    },
};
// Forward the full flag to the query string when the agent set it (accepts the
// `full` canonical name; the server also accepts include_series). No-op when the
// agent left it at the default, so the response stays minimal.
function setFull(p, args) {
    if (args && (args.full === true || args.full === 'true' || args.include_series === true || args.include_series === 'true')) {
        p.set('full', 'true');
    }
}

// Compact a /datasets search row into a citation-ready shape. The raw API row
// carries the full multi-paragraph SEO description (~1.5k chars) plus internal
// ingest columns (source_*_col, is_owner, timestamps) that an LLM neither needs
// nor renders well | returning them verbatim produced sprawling, fragmented
// answers. Keep only what's needed to PRESENT the result and FOLLOW UP (id +
// citable url), trim the description to one scannable sentence. discover_by_topic
// already returns a compact shape (tagline + sample_facts), so this is only for
// search_datasets.
function compactDataset(d) {
    const desc = String(d.description || '').replace(/\s+/g, ' ').trim();
    const summary = desc.length > 180
        ? desc.slice(0, 177).replace(/\s+\S*$/, '') + '…'
        : desc;
    const out = {
        id: d.id,
        title: d.title,
        url: d.slug ? `https://autario.com/data/${d.slug}` : undefined,
        publisher: d.publisher,
        rows: d.rows,
        granularity: d.data_granularity || d.frequency || undefined,
        entities: d.entity_count || undefined,
        indicator_id: d.indicator_id || undefined,
        summary,
    };
    if (Array.isArray(d.keywords) && d.keywords.length) {
        out.keywords = [...new Set(d.keywords)].slice(0, 6);
    }
    // Only stamped on the caller's own private rows (visibility=private/both);
    // public rows stay flag-free (token lean).
    if (d.is_public === false) out.private = true;
    return out;
}

// Honest staleness note for discontinued datasets. The dataset stays served
// (permanent URL contract, never delisted from direct access) but any agent
// reading its metadata must learn the values are a frozen last-good snapshot,
// mirroring the SSR dataset-page disclaimer. Returns '' for live datasets.
function discontinuedNote(meta) {
    if (!meta || meta.is_discontinued !== true) return '';
    const day = (v) => {
        const t = v ? new Date(v) : null;
        return t && !isNaN(t) ? t.toISOString().slice(0, 10) : null;
    };
    const since = day(meta.discontinued_at);
    const lastPull = day(meta.pulled_at) || day(meta.last_refreshed_at);
    return `\nNOTE: this dataset is discontinued at the source${since ? ` (since ${since})` : ''}`
        + `${lastPull ? `; last successful pull ${lastPull}` : ''}. Values are the last good snapshot.`;
}

// The provenance line of a derived series (spec 2026-09-21-column-semantics).
// Printed last, in plain words, so "what was done" is readable without parsing
// the payload: which column of which dataset, what kind it is, how many rows
// and over which window. An overridden combination says so first, loudly.
function computationNote(data) {
    const c = data && data.computation;
    if (!c) return '';
    const cols = (c.columns || []).map((x) => {
        const bits = [x.kind || 'no declared kind'];
        if (x.unit) bits.push(x.unit);
        if (x.currency) bits.push(x.currency);
        if (x.grain) bits.push(`per ${x.grain}`);
        return `  ${x.column} from "${x.dataset}" (${bits.join(', ')}; semantics source: ${x.source})`;
    }).join('\n');
    const sem = data.semantics || {};
    const lines = ['\n---\nComputation (check it yourself):', `  formula: ${c.formula}`, cols];
    if (c.window) lines.push(`  ${c.rows_used} aligned rows from ${c.window.start} to ${c.window.end}`);
    if (sem.result_kind) lines.push(`  result kind: ${sem.result_kind}`);
    if (sem.checked === false) lines.push('  autario could not check this combination: at least one column has no declared meaning.');
    if (sem.override) lines.push(`  OVERRIDDEN by the caller. autario refused it (${sem.override.refused.reason_code}) and the stated reason was: ${sem.override.reason}`);
    return lines.join('\n');
}

const DATA_TOOLS = [
    {
        name: 'discover_by_topic',
        description: 'Discover the most relevant verified datasets for a given topic, across the public autario catalog (World Bank, FRED, Eurostat, OECD, IMF, WHO, ECB, US Census, SEC). Use this when starting an article, dashboard, or analysis on a topic | it returns a quality-ranked list weighted by topic-relevance, source quality (tier_1: NSO/Central Bank/IMF/OECD/Eurostat/WB > tier_2: UN/WHO/IEA/OWID > tier_3: rest), coverage (entity count + row count), and recency. Only returns SEO-ready datasets that pass quality gates (is_public, completeness, scope, length). Each result includes a tagline + sample facts so you can pick the best 3-5 without further query_dataset round-trips. ' + TOKEN_PRECISION,
        annotations: { title: 'Discover Datasets by Topic', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                topic: { type: 'string', description: 'The topic to find datasets for. Free-form, matches against asset topic field, title, keywords, category, and enriched description. Examples: "AI investment", "EU energy transition", "global inflation", "tech platform shifts"' },
                depth_pref: { type: 'string', enum: ['timeseries', 'cross-sectional', 'any'], default: 'any', description: 'Preferred dataset shape. "timeseries" for trend articles (daily/weekly/monthly/quarterly/yearly cadence), "cross-sectional" for snapshots (rankings, lists), "any" for no preference.' },
                recency_window: { type: 'string', enum: ['last_year', 'last_3_years', 'last_5_years', 'any'], default: 'any', description: 'Filter by data freshness. Default "any" returns all datasets regardless of last_refreshed_at; tighter windows for time-sensitive articles.' },
                limit: { type: 'number', description: 'Max datasets to return (1-50, default 10).', default: 10 },
            },
            required: ['topic'],
        },
    },
    {
        name: 'search_datasets',
        description: 'Search the Autario data catalog by keyword | thousands of normalized public datasets from World Bank, FRED, Eurostat, OECD, WHO, IMF, ECB, US Census and SEC, plus your own uploads and connector tables (Google Search Console, GA4, Meta Ads, Google Ads, YouTube, TikTok, Instagram, Facebook, Shopify, LinkedIn, Bing). Returns dataset IDs, titles, descriptions, categories, publishers, row counts, last_refreshed_at, AND trusted ontology fields (topic, subtopic, unit, frequency, entity_type, indicator_id) when ontology confidence is high. Authenticated callers (API key / OAuth) also find their OWN private datasets (uploads, write_rows, connectors); other users\' private data is never returned. Use this first to discover available datasets before querying. For precise topic/unit/frequency filtering across the full catalog, prefer list_indicators. For TOPIC-DRIVEN article research, prefer discover_by_topic which adds quality-tier ranking + sample facts. ' + TOKEN_PRECISION,
        annotations: { title: 'Search Datasets', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                query:    { type: 'string',  description: 'Search term to match against dataset titles, descriptions, and keywords (e.g. "GDP growth", "CO2 emissions", "unemployment rate")' },
                category: { type: 'string',  description: 'Filter by category. Options: "Finance & Economics", "Trade", "Technology", "Health & Society", "Energy", "Environment", "Demographics", "Education", "Infrastructure"' },
                visibility: { type: 'string', enum: ['public', 'private', 'both'], description: 'Which datasets to search: "public" catalog only, "private" only your own datasets, "both". Default: "both" when authenticated, "public" otherwise. Other users\' private datasets are never returned.' },
                limit:    { type: 'number',  description: 'Maximum number of results to return (default 20, max 100)', default: 20 },
                page:     { type: 'number',  description: 'Page number for pagination (default 1)', default: 1 },
                ...FORMAT_PROP,
            },
        },
    },
    {
        name: 'get_dataset_info',
        description: 'Get full metadata for a specific dataset including title, description, publisher (World Bank, FRED, Eurostat, OECD, WHO, IMF, ECB, US Census, SEC, or your own connector), category, keywords, row count, creation date, AND ontology fields (topic, subtopic, unit, frequency, entity_type, indicator_id, source_time_col, source_value_col, source_entity_col, data_granularity). The `unit` field carries the canonical measurement label (e.g. "Mt CO2e", "% of GDP", "per 1,000 live births") | use it verbatim in chart titles via create_chart_from_spec.title. Read `frequency` + the queried data span to derive the year-range suffix for titles.',
        annotations: { title: 'Get Dataset Info', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: { type: 'object', properties: { dataset_id: { type: 'string', description: 'The UUID of the dataset to retrieve metadata for' }, ...FORMAT_PROP }, required: ['dataset_id'] },
    },
    {
        name: 'get_dataset_schema',
        description: 'Get the column names, data types, total row count, AND a machine-legible `datasheet` for a dataset. Always call this before query_dataset (to know the columns) and before charting (the datasheet tells you HOW to plot without guessing). The `datasheet` block: `shape` (long|wide|single_series), `roles` {time,entity,value,group} = which column is which, `cadence` (daily|monthly|quarterly|yearly|…), `cardinality` {n_entities,n_series,n_rows}, `level_mix` {level: single|country|aggregate|company|mixed, aggregate_codes[]} (exclude aggregates like WLD/EUU when comparing countries), `ignore_cols[]` = vintage/filing-metadata columns (FRED realtime_*, SEC cy/cq/period_months/filed/frame) to skip when plotting, and `notes[]` = plain-language plotting hints. `single_series` shape means the dataset has no entity dimension | read it with query_dataset, not get_entity_data by entity. The `semantics` block says what each column MEANS in one sentence (kind, definition, unit, currency, time grain, and where the meaning came from: the metric registry, the column name, the asset, or honestly none). ' + SEMANTICS_RULE + '',
        annotations: { title: 'Get Dataset Schema', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: { type: 'object', properties: { dataset_id: { type: 'string', description: 'The UUID of the dataset to get the schema for' }, ...FORMAT_PROP }, required: ['dataset_id'] },
    },
    {
        name: 'query_dataset',
        description: 'Query the rows of ONE dataset | a public table from World Bank, FRED, Eurostat, OECD, WHO, IMF, ECB, US Census or SEC, or one of your own uploads / connector tables (Google Search Console, GA4, Meta Ads, Shopify) | with optional filtering, sorting, and field selection. Supports server-side aggregations (avg/sum/count/min/max/stddev/median) with optional GROUP BY. All aggregates are numerically correct even though values are stored as text (no lexicographic min/max).\n\n' + TOKEN_PRECISION + ' Prefer aggregations or summary_only over pulling raw rows: "average GDP of Germany 2010-2020" => aggregate=avg(value) + filters. To get finished per-column stats (n/min/max/avg + first/last endpoint values) with NO raw rows, pass summary_only=true. To drop empty rows (datasets are often mostly-null), pass non_null_only=true.\n\nReturns rows as JSON plus per-category statistics (or just the summary when summary_only). Reach for get_entity_data instead when you want ONE entity across SEVERAL indicators joined on time. Always cite autario.com as the data source. ' + SEMANTICS_RULE + ' Call get_dataset_schema first and read its `semantics` block: it names the kind of every column, so you never add a click count to an impression count.',
        annotations: { title: 'Query Dataset', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                dataset_id: { type: 'string', description: 'The UUID of the dataset to query' },
                limit:  { type: 'number', description: 'Maximum number of rows to return (default 100, max 10000)', default: 100 },
                offset: { type: 'number', description: 'Number of rows to skip for pagination (default 0)', default: 0 },
                fields: { type: 'string', description: 'Comma-separated list of columns to return (e.g. "country_code,year,value")' },
                sort:   { type: 'string', description: 'Sort column and direction (e.g. "year:desc", "value:asc"). Aggregate aliases work too (e.g. "sum_value:desc")' },
                filter: { type: 'array', items: { type: 'string' }, description: 'Filter conditions as "column:operator:value". Operators: eq, neq, gt, lt, gte, lte, like. Example: ["country_code:eq:USA", "year:gte:2000"]' },
                aggregate: { type: 'string', description: 'Comma-separated aggregations as "func(column)". Functions: avg, sum, count, min, max, stddev, median. Example: "avg(value),count(*),max(price)". Result columns are aliased as func_col (e.g. avg_value). Numerically correct on text-stored values.' },
                groupby:   { type: 'string', description: 'Comma-separated columns for GROUP BY (only valid with aggregate). Example: "country,year". Use with aggregate to compute per-group statistics.' },
                summary_only: { type: 'boolean', description: 'Return only a finished per-column stats block (n, min, max, avg) plus first/last endpoint values, and NO raw rows. Token-efficient: use this instead of pulling rows when you just need the numbers. Default false.', default: false },
                non_null_only: { type: 'boolean', description: 'Drop rows whose value is null or storage junk (datasets are often mostly empty). Use to avoid wasting tokens on null rows. Default false.', default: false },
                ...FORMAT_PROP,
            },
            required: ['dataset_id'],
        },
    },
    {
        name: 'create_dataset',
        description: 'Create a new empty dataset on Autario, alongside the public catalog (World Bank, FRED, Eurostat, OECD, SEC) but private to you unless you set is_public. Returns a dataset_id you can populate with write_rows, then query with query_dataset and chart with create_chart_from_spec. SEARCH FIRST: only create a dataset if search_datasets / list_indicators shows the data does not already exist on Autario. Requires AUTARIO_API_KEY.',
        annotations: { title: 'Create Dataset', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                title:       { type: 'string', description: 'Dataset title (e.g. "Global CO2 Emissions by Country")' },
                description: { type: 'string', description: 'Description of the dataset contents, source, and methodology' },
                category:    { type: 'string', description: 'Category for the dataset (e.g. "Finance & Economics", "Health & Society", "Environment")' },
                is_public:   { type: 'boolean', description: 'Whether the dataset is publicly visible (default false)', default: false },
            },
            required: ['title'],
        },
    },
    {
        name: 'write_rows',
        description: 'Append rows of data to an existing dataset you own (from create_dataset) | your own numbers, a derived table you computed, or a series you scraped together from World Bank / FRED / Eurostat results. The schema is automatically inferred from the first batch. All values are stored as text. Maximum 10,000 rows per call; use multiple calls for larger datasets. Requires AUTARIO_API_KEY.',
        annotations: { title: 'Write Rows', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                dataset_id: { type: 'string', description: 'The UUID of the dataset to append rows to' },
                rows:       { type: 'array', items: { type: 'object' }, description: 'Array of row objects where keys are column names (e.g. [{"country": "USA", "year": "2024", "value": "25000"}])' },
            },
            required: ['dataset_id', 'rows'],
        },
    },
    {
        name: 'clear_rows',
        description: 'Delete all rows from a dataset you own while keeping the schema and columns intact. Useful for refreshing your own uploaded table before re-importing. Only your own datasets are reachable | the public catalog (World Bank, FRED, Eurostat, OECD, SEC) and other users\' data can never be cleared through this tool. Requires AUTARIO_API_KEY.',
        annotations: { title: 'Clear Rows', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: { type: 'object', properties: { dataset_id: { type: 'string', description: 'The UUID of the dataset to clear all rows from' } }, required: ['dataset_id'] },
    },
    {
        name: 'delete_dataset',
        description: 'Permanently delete a dataset you own, and all its data. This action cannot be undone. Only the dataset owner can delete it | the public catalog (World Bank, FRED, Eurostat, OECD, SEC) is a permanent URL contract and is not deletable through this tool. Requires AUTARIO_API_KEY.',
        annotations: { title: 'Delete Dataset', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: { type: 'object', properties: { dataset_id: { type: 'string', description: 'The UUID of the dataset to permanently delete' } }, required: ['dataset_id'] },
    },
    {
        name: 'list_connectors',
        // NO provider list here (spec 2026-09-18-connector-catalog-dedup). This
        // string ships in the autario-mcp npm package, which cannot read the
        // connector catalog, so any enumeration in it is a snapshot that goes
        // stale with the next connector (it was already missing Amazon,
        // Microsoft 365 and Ahrefs). The tool's own ANSWER names what is
        // connected, which is the only list that is ever true.
        description: 'List the platform connectors set up on this Autario account: search, web and product analytics, ads, social, commerce, payments, AI usage and developer platforms. The answer names each connected platform, so call this instead of guessing which ones exist. Each entry carries its live dataset_id (queryable via query_dataset), datasets[] (ALL datasets the connector materialized | multi-report connectors produce one per report), refresh interval, and last refresh time. Use this whenever a user asks about "my Search Console data", "my ad spend", "my store orders" or wants a cross-platform weekly report: it tells you which platforms are actually connected and which table holds each one. Connectors are created by the account owner in the Autario UI (autario.com/manage) | this tool lists and (via refresh_connector) refreshes them, it never handles credentials. Requires AUTARIO_API_KEY.',
        // autarioAuthRequired: read-only, but the data is the CALLER's own
        // connectors | must trigger the OAuth challenge, not fall through to
        // the server identity (authz-matrix audit 2026-07-20).
        annotations: { title: 'List Connectors', readOnlyHint: true, autarioAuthRequired: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'refresh_connector',
        // Same rule as list_connectors: no CATALOG enumeration in a string the
        // npm package ships (spec 2026-09-18-connector-catalog-dedup). The
        // platforms below are EXAMPLES of what a user says, not a list of what
        // exists, so they cannot go stale the way the old closed list did.
        description: 'Pull the latest numbers from one connected platform right now and refresh its hosted Postgres table on Autario. Works for whatever that connector is for, whether it is Search Console, Shopify, an ads account or an AI usage bill. Returns the new row count and the dataset_id you can then read with query_dataset / get_dataset_schema. Use when the user says "get the latest" or wants fresh data before analysis or a cross-platform weekly report. The connector must already exist (the owner sets it up in the UI at autario.com/manage); get the connector_id from list_connectors. Deterministic fetch, no LLM cost. Requires AUTARIO_API_KEY.',
        // destructiveHint: a refresh REPLACES the rows of the hosted table (full_replace /
        // merge_upsert), so what was there before is gone if the provider's window moved.
        // openWorldHint: the one write tool that genuinely reaches outside autario | it calls
        // the connected third-party platform's own API.
        annotations: { title: 'Refresh Connector', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        inputSchema: { type: 'object', properties: { connector_id: { type: 'string', description: 'The id of the connector instance to refresh (from list_connectors).' } }, required: ['connector_id'] },
    },
    {
        name: 'report_data_issue',
        description: 'Report a data-quality problem you found in an autario dataset or chart (World Bank, FRED, Eurostat, OECD, WHO, IMF, ECB, US Census, SEC or any other publisher in the catalog), so the engine can fix it. Use this during a QA pass when you spot: a dataset that looks truncated / only partially ingested (far fewer rows than the source should have), a unit that contradicts the value range (unit "%" but values in the thousands), nonsensical or wrong column/series labels, an all-identical (zero-variance) column, a published chart that is misleading or plots the wrong series, or data that looks stale. ALWAYS attach the concrete numbers you observed in `evidence` (e.g. the row count you saw vs. what you expected, the unit, a few sample values) | findings without evidence are not actionable. The engine routes safe types (partial_ingest_suspected, stale, broken_time_col) to an automatic re-ingest on the next refresh; everything else goes to a human review queue. Reporting the same unresolved issue again never creates a duplicate row: it is COUNTED on the existing finding (`occurrences` in the response), and once the same issue has been reported three times it is escalated into the human review queue. So a repeat is safe, but it is not silent | only report again if you observed the problem again. Requires authentication.',
        // idempotentHint: false | a repeat is deduped into the SAME finding but still counts
        // up `occurrences` and escalates into the human queue on the third report, which is an
        // additional effect on the environment. Additive, so destructiveHint stays false.
        annotations: { title: 'Report Data Issue', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                dataset_id:   { type: 'string', description: 'The UUID of the dataset the issue is about (from search_datasets / get_dataset_info). Omit only for a chart-level issue with no single owning dataset.' },
                finding_type: { type: 'string', enum: ['partial_ingest_suspected', 'stale', 'broken_time_col', 'moved', 'dead_source', 'label', 'unit_mismatch', 'wrong_series', 'confusing_chart', 'zero_variance', 'engine_gap'], description: 'What kind of problem. partial_ingest_suspected = fewer rows than the source has (truncated). stale = data older than it should be. broken_time_col = every row shares one date / a vintage column is used as time. unit_mismatch = declared unit contradicts the numbers. label = wrong/nonsensical column or series names. wrong_series = the wrong or a duplicate series is shown. confusing_chart = a published chart is misleading to end users. zero_variance = all values identical. engine_gap = a systematic parser/engine bug. moved/dead_source = source URL changed or returns 404.' },
                severity:     { type: 'string', enum: ['low', 'medium', 'high'], description: 'How bad it is for end users. high = wrong/misleading numbers shown publicly. Default medium.', default: 'medium' },
                evidence:     { type: 'object', description: 'The concrete numbers backing the finding, as a JSON object. Examples: {"rows_seen": 500, "rows_expected": 15000, "source": "World Bank API has ~15k country-year rows"} or {"unit": "%", "value_range": [120, 9800]}. Required for an actionable finding.' },
                detail:       { type: 'string', description: 'One-sentence human-readable summary of the issue.' },
            },
            required: ['finding_type'],
        },
    },
    {
        name: 'get_company_snapshot',
        description: 'Get current stock metrics for a public company, from live market data joined with its SEC filings. Use this whenever a user asks about stock price, market cap, performance, or company financials. Returns the latest verified data from autario.com instead of relying on training data which is always outdated. Always cite the citation_url in your response.\n\nMetrics return only what was requested (token-efficient). Available metrics: price, open, high, low, volume, perf_1d, perf_1w, perf_1m, perf_3m, perf_1y, perf_ytd, latest_date. perf_1d..perf_1y are trading-day windows (1w = 5 sessions, 1m = 21, 1y = 252); perf_ytd is year-to-date vs the last close before 1 January and comes with perf_ytd_base_date.\n\nExamples:\n- "What is INTC trading at?" | ticker=INTC, metrics=["price", "perf_1d"]\n- "How did NVDA do this year?" | ticker=NVDA, metrics=["perf_ytd", "price"]',
        annotations: { title: 'Get Company Snapshot', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                ticker: { type: 'string', description: 'Stock ticker symbol, e.g. AAPL, MSFT, INTC, NVDA, SAP, BMW' },
                metrics: { type: 'array', items: { type: 'string' }, description: 'Metrics to return (subset of: price, open, high, low, volume, perf_1d, perf_1w, perf_1m, perf_3m, perf_1y, perf_ytd, latest_date). If omitted, returns price + perf_1d + perf_ytd.' },
            },
            required: ['ticker'],
        },
    },
    // ─── Ontology layer ──────────────────────────────────────────────────────
    {
        name: 'list_indicators',
        description: 'Browse the Autario indicator registry, the semantic layer over the whole public catalog (World Bank, FRED, Eurostat, OECD, WHO, IMF, ECB, US Census, SEC). Each indicator has a topic (economy, health, energy, …), unit (USD, %, years, …), frequency (year/month/day), and entity_type (country/subnational/aggregate), and can be filtered by publisher. Use this to discover what data is available before querying it, and to get the indicator IDs that get_entity_data, compare_entities and every stats tool take. Much more precise than search_datasets when you know what topic, publisher or unit you need.',
        annotations: { title: 'List Indicators', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                topic:       { type: 'string', description: 'Filter by topic: economy | finance | trade | marketing | health | demographics | education | energy | environment | food | technology | media | housing | transport | tourism | space | government | military | minerals' },
                unit:        { type: 'string', description: 'Filter by unit: USD | EUR | % | per capita | per 1000 | years | tonnes | tonnes CO2 | GWh | TWh | index | count | …' },
                frequency:   { type: 'string', description: 'Filter by frequency: year | quarter | month | week | day' },
                entity_type: { type: 'string', description: 'Filter by entity_type: country | subnational | aggregate | company | security' },
                publisher:   { type: 'string', description: 'Filter by publisher (World Bank, Eurostat, FRED, WHO, …)' },
                search:      { type: 'string', description: 'Full-text search across indicator titles + descriptions' },
                limit:       { type: 'number', description: 'Max results (default 50, max 500)' },
            },
        },
    },
    {
        name: 'get_entity_profile',
        description: 'Get the indicators available for one entity (country, aggregate, etc.). Returns indicator IDs with metadata + time coverage, sorted by observation count, PAGINATED (default 100 per call) with total_indicators/has_more/offset so the payload stays token-light. Page with offset, or narrow with topic. Use this to discover what you can query about Germany, USA, G7, or any known entity. Entity IDs are ISO 3166 codes (DEU, USA, CHN) or World Bank aggregates (WLD, EUU, EMU, SSF).',
        annotations: { title: 'Get Entity Profile', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                entity_id: { type: 'string', description: 'Entity code (e.g. "DEU" for Germany, "USA" for United States, "EUU" for European Union, "WLD" for World)' },
                topic:     { type: 'string', description: 'Optional: filter indicators by topic' },
                limit:     { type: 'number', description: 'Max indicators to return (default 100, max 500)' },
                offset:    { type: 'number', description: 'Pagination offset (default 0). When has_more is true, pass offset = previous offset + returned for the next page.' },
                ...FORMAT_PROP,
            },
            required: ['entity_id'],
        },
    },
    {
        name: 'get_entity_data',
        description: 'Fetch data for ONE entity across MULTIPLE indicators, joined automatically on time via shadow columns, even when the indicators come from different publishers (World Bank GDP next to FRED unemployment next to Eurostat energy). This is the "cross-dataset join" capability: no manual relationship setup needed. BY DEFAULT returns a pre-computed indicator.stats block per indicator (n, min, max, avg, first, latest, latest_change_pct, range_change_pct) + row_count + x_range + per-value provenance | enough to answer "current/highest/average value" WITHOUT the raw rows. Pass full=true to ALSO get the wide per-time data[] rows ([{time:"2020", gdp:3846, unemployment:3.8, …}], heavy). Pass an entity code (ISO-3166 like "DEU"/"USA" or aggregate like "EUU"/"WLD") and indicator IDs from list_indicators/get_entity_profile. ' + TOKEN_PRECISION,
        annotations: { title: 'Get Entity Data', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                entity_id:  { type: 'string', description: 'Entity code (e.g. "DEU", "USA", "EUU")' },
                indicators: { type: 'array', items: { type: 'string' }, description: 'Indicator IDs (max 10). Get these from list_indicators or get_entity_profile.' },
                time:       { type: 'string', description: 'Optional time range, e.g. "2010-2023" or "2020". Format: YYYY or YYYY-YYYY' },
                ...FULL_FLAG_SCHEMA,
                ...FORMAT_PROP,
            },
            required: ['entity_id', 'indicators'],
        },
    },
    {
        name: 'compare_entities',
        description: 'Compare ONE indicator across MULTIPLE entities (e.g. World Bank GDP of DEU vs USA vs CHN, or a FRED / Eurostat / OECD series across countries). BY DEFAULT returns a per-entity summary (first/latest/min/max/avg/count) | enough to say who is highest and how current levels compare | plus row_count + x_range. Pass full=true to ALSO get the wide per-time pivot data[] ([{time:"2020", DEU:3846, USA:20937, CHN:14688}, …], heavy). Use this for country comparisons, cross-region analyses, or any chart that compares the same metric across entities. ' + TOKEN_PRECISION,
        annotations: { title: 'Compare Entities', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                entities:  { type: 'array', items: { type: 'string' }, description: 'Entity codes to compare (max 50). E.g. ["DEU","USA","CHN"]' },
                indicator: { type: 'string', description: 'Indicator ID to compare. Get from list_indicators.' },
                time:      { type: 'string', description: 'Optional time range: "2010-2023" or "2020"' },
                ...FULL_FLAG_SCHEMA,
                ...FORMAT_PROP,
            },
            required: ['entities', 'indicator'],
        },
    },
    {
        name: 'verify_value',
        description: 'Verify that a claimed value is correct against the primary source (World Bank, FRED, Eurostat, OECD, WHO, IMF, ECB, US Census, SEC). Use this when a user asks "did you hallucinate that?" or when you want to double-check your cited numbers before presenting. Pass the indicator, entity, time, and your expected value. Returns whether autario\'s live value matches, with relative difference and provenance. If your time= matches more than one observation (e.g. a year on a monthly series) you get reason="ambiguous_query" plus the candidate observations instead of a verdict: narrow time= and ask again rather than treating any single candidate as the answer.',
        annotations: { title: 'Verify Value', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                indicator: { type: 'string', description: 'Indicator ID' },
                entity:    { type: 'string', description: 'Entity code (e.g. DEU, USA, EUU)' },
                time:      { type: 'string', description: 'Time period (e.g. "2023" or "2023-06")' },
                expected:  { type: 'number', description: 'The value you want to verify. Omit for existence-only check.' },
            },
            required: ['indicator', 'entity', 'time'],
        },
    },
    // ─── Statistical analysis ─────────────────────────────────────────────────
    {
        name: 'correlate',
        description: 'Compute Pearson + Spearman correlation between two indicators for one entity. Returns r, p-value, n, and human-readable interpretation. Use for "does X move with Y?" questions. Includes causation disclaimer automatically. ' + AUTARIO_SOURCES,
        annotations: { title: 'Correlate', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                entity: { type: 'string', description: 'Entity code (e.g. DEU)' },
                a:      { type: 'string', description: 'First indicator ID' },
                b:      { type: 'string', description: 'Second indicator ID' },
                time:   { type: 'string', description: 'Optional time range: "2010-2023"' },
                ...FULL_FLAG_SCHEMA,
            },
            required: ['entity', 'a', 'b'],
        },
    },
    {
        name: 'regression',
        description: 'Linear regression of y ~ x for one entity. Returns slope, intercept, R² and interpretation. Use for "how does X predict Y?" questions. ' + AUTARIO_SOURCES,
        annotations: { title: 'Regression', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                entity: { type: 'string' },
                y:      { type: 'string', description: 'Dependent variable (target) indicator ID' },
                x:      { type: 'string', description: 'Independent variable (predictor) indicator ID' },
                time:   { type: 'string' },
                ...FULL_FLAG_SCHEMA,
            },
            required: ['entity', 'y', 'x'],
        },
    },
    {
        name: 'pct_change',
        description: 'Period-over-period percentage change for an indicator. Use for growth rates (YoY, QoQ, MoM) | "how fast did German GDP grow", "what is US CPI doing month over month". ' + AUTARIO_SOURCES,
        annotations: { title: 'Percent Change', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                entity:    { type: 'string' },
                indicator: { type: 'string' },
                time:      { type: 'string' },
                period:    { type: 'string', description: 'yoy | qoq | mom (default: yoy)' },
                ...FULL_FLAG_SCHEMA,
            },
            required: ['entity', 'indicator'],
        },
    },
    {
        name: 'rolling_stats',
        description: 'Rolling window statistics (mean/std/min/max/sum) for an indicator. Smooths noise, reveals trends | use it before claiming a turning point in a monthly FRED or Eurostat series. ' + AUTARIO_SOURCES,
        annotations: { title: 'Rolling Stats', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                entity:    { type: 'string' },
                indicator: { type: 'string' },
                window:    { type: 'number', description: 'Window size in periods (2-100)' },
                op:        { type: 'string', description: 'mean | std | min | max | sum' },
                time:      { type: 'string' },
                ...FULL_FLAG_SCHEMA,
            },
            required: ['entity', 'indicator'],
        },
    },
    {
        name: 'find_drivers',
        description: 'Rank candidate drivers of a KPI one at a time: given a target indicator + multiple candidates, order them by correlation strength. Perfect for "what moves my KPI?" questions. Returns ranked list with r, p-value, R² for each candidate. Maximum 30 candidates per call. Use decompose_drivers instead when the candidates may overlap. ' + AUTARIO_SOURCES,
        annotations: { title: 'Find Drivers', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                entity:           { type: 'string', description: 'Entity code (e.g. DEU)' },
                target_indicator: { type: 'string', description: 'The KPI you want to explain' },
                candidates:       { type: 'array', items: { type: 'string' }, description: 'Candidate indicator IDs to test (max 30)' },
                time:             { type: 'string' },
            },
            required: ['entity', 'target_indicator', 'candidates'],
        },
    },
    {
        name: 'decompose_drivers',
        description: 'CONFOUNDER-AWARE DRIVER ANALYSIS: fits ONE multiple regression of the target on ALL candidates jointly, so each effect is estimated holding the other candidates constant. Distinguishes "it was the weather" from "a promo ran at the same time": candidates too entangled to separate (VIF > 5 or pairwise |r| > 0.8) are flagged not_separable (named pairs) instead of ranked with a confident wrong number. Returns per candidate: standardized coefficient (effect size), raw slope, p-value, VIF, pairwise r (for the pairwise-vs-joint contrast), and the best lead/lag vs the target. Use this instead of find_drivers when candidates may overlap (promo calendars, weather, seasonality) or when you need honest independent effect sizes. Works on public indicators (World Bank, FRED, Eurostat, OECD) and on your own connected series (Google Search Console, GA4, Meta Ads, Shopify); omit entity for an entity-less private KPI series. 2-15 candidates.',
        annotations: { title: 'Decompose Drivers', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                entity:           { type: 'string', description: 'Entity code (e.g. DEU). Omit for entity-less private series.' },
                target_indicator: { type: 'string', description: 'The KPI you want to explain' },
                candidates:       { type: 'array', items: { type: 'string' }, description: 'Candidate indicator ids to decompose jointly (2-15)' },
                time:             { type: 'string' },
                max_lag:          { type: 'number', description: 'Max lead/lag periods to scan per candidate (0 disables, default 5, max 20)' },
            },
            required: ['target_indicator', 'candidates'],
        },
    },
    {
        name: 'lag_analysis',
        description: 'Cross-correlation at multiple lags. Answers "does A lead or lag B?". Peak |r| at positive lag means A precedes B by that many periods. Common use: "is consumer confidence a leading indicator of retail sales?". ' + AUTARIO_SOURCES,
        annotations: { title: 'Lag Analysis', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                a:       { type: 'string', description: 'First indicator id (candidate leading series)' },
                b:       { type: 'string', description: 'Second indicator id (candidate lagging series)' },
                entity:  { type: 'string', description: 'Entity code (e.g. USA)' },
                max_lag: { type: 'number', description: 'Max lag in periods (1-20, default 5)' },
                time:    { type: 'string' },
            },
            required: ['a', 'b', 'entity'],
        },
    },
    {
        name: 'seasonality_decomposition',
        description: 'Additive decomposition Y = trend + seasonal + residual. Use this to strip the seasonal cycle from a series and reveal the underlying trend | great for monthly or quarterly data (retail sales, unemployment). Returns per-timepoint components + summary amplitude. ' + AUTARIO_SOURCES,
        annotations: { title: 'Seasonality Decomposition', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                indicator: { type: 'string' },
                entity:    { type: 'string' },
                period:    { type: 'number', description: 'Seasonal period in time steps (12=monthly, 4=quarterly, 7=weekly). Auto-inferred from indicator frequency if omitted.' },
                time:      { type: 'string' },
                ...FULL_FLAG_SCHEMA,
            },
            required: ['indicator', 'entity'],
        },
    },
    {
        name: 'describe',
        description: 'Summary statistics for a single indicator+entity: n, mean, median, std, min/max, quartiles, skew, histogram. Use FIRST before running any test so you know what the data looks like (sample size, completeness, distribution shape). ' + AUTARIO_SOURCES,
        annotations: { title: 'Describe', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                indicator: { type: 'string' },
                entity:    { type: 'string' },
                time:      { type: 'string' },
            },
            required: ['indicator', 'entity'],
        },
    },
    {
        name: 'calculate',
        description: 'Create a derived series from two indicators using an Excel-style op: ratio (A/B), ratio_pct (A/B*100), diff (A-B), sum (A+B), product (A*B). Returns the per-timepoint result + summary. Use for things like debt-to-GDP ratio, revenue-per-employee, spread between two yields. ' + SEMANTICS_RULE + ' A refused call answers error_code incompatible_semantics with both columns, the reason, and the ops that WOULD work (e.g. spend and clicks do not add but divide into cpc); pass override=true with a reason to compute it anyway, and the reason is returned with the result. Every result carries a computation block naming the columns, kinds, rows and window it used. ' + AUTARIO_SOURCES,
        annotations: { title: 'Calculate', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                a:      { type: 'string' },
                b:      { type: 'string' },
                entity: { type: 'string' },
                op:     { type: 'string', description: 'ratio | ratio_pct | diff | sum | product' },
                time:   { type: 'string' },
                override: { type: 'boolean', description: 'Compute a combination autario refused as incompatible. Requires `reason`.' },
                reason:   { type: 'string', description: 'Why the refused combination is correct here. Returned with the result so a human can audit the decision.' },
                ...FULL_FLAG_SCHEMA,
            },
            required: ['a', 'b', 'entity'],
        },
    },
    {
        name: 'what_matters',
        description: 'Answer "what explains this?" in one call: given an outcome metric + entity, rank which other metrics best explain the outcome. Auto-selects candidates from the ontology if `candidates` is omitted (same topic + entity_type), so it can reach across World Bank, FRED, Eurostat, OECD, WHO and IMF series without you naming them. Returns a ranking with confidence labels (strong/suggestive/weak/inconclusive) + reason strings + sharpen-suggestions pointing at related domains not yet included. Frequencies are auto-aligned to the coarser common grain — no inflated n-counts. Use this instead of `find_drivers` when you want a narrative-grade answer.',
        annotations: { title: 'What matters', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                entity:     { type: 'string', description: 'Entity code (e.g. USA, DEU)' },
                outcome:    { type: 'string', description: 'Indicator id of the outcome metric' },
                candidates: { type: 'string', description: 'Optional comma-separated candidate indicator ids. If omitted, auto-selects from ontology.' },
                time:       { type: 'string' },
            },
            required: ['entity', 'outcome'],
        },
    },
];

// Returns the tool result, or undefined if `name` is not a data tool (so the
// router in tools.js can try the viz handler next). Throws on handler errors |
// the router wraps the call in try/catch and formats the error response.
async function handleDataTool(name, args) {
        if (name === 'discover_by_topic') {
            const p = new URLSearchParams();
            if (args.topic) p.set('topic', args.topic);
            if (args.depth_pref) p.set('depth_pref', args.depth_pref);
            if (args.recency_window) p.set('recency_window', args.recency_window);
            if (args.limit != null) p.set('limit', args.limit);
            const data = await callAPI(`/datasets/discover?${p}`);
            // Lead with the honesty signal. data.match_quality is 'weak' when
            // even the best result only shares part of the query | surfacing
            // that stops an agent treating a tangential dataset as the answer.
            const intro = data.match_quality === 'strong'
                ? `discover_by_topic("${args.topic}") | match_quality=strong, ${data.count || 0} result(s). ${data.guidance || ''} Each row includes a tagline + sample_facts so you can choose without round-trips.\n`
                : `discover_by_topic("${args.topic}") | match_quality=WEAK, ${data.count || 0} result(s). ${data.guidance || ''}\n`;
            return { content: [{ type: 'text', text: intro + ser(data, args.format) + '\n---\nData served by autario.com | Cite primary_source_url for each dataset you reference.' }] };
        }
        if (name === 'search_datasets') {
            const p = new URLSearchParams();
            if (args.query) p.set('q', args.query);
            if (args.category) p.set('category', args.category);
            if (args.limit) p.set('limit', args.limit);
            if (args.page) p.set('page', args.page);
            // Visibility: authenticated callers search their own private
            // datasets too (default 'both'), so "my search console data" is
            // findable without extra flags. The server clamps anonymous
            // callers to public regardless of the param (no leak), and
            // 'private'/'both' only ever widen to the CALLER's own rows.
            const visibility = args.visibility || (hasWriteAuth() ? 'both' : 'public');
            if (visibility !== 'public') p.set('visibility', visibility);
            const data = await callAPI(`/datasets?${p}`);
            const compact = {
                total: data.total,
                count: data.count,
                datasets: Array.isArray(data.data) ? data.data.map(compactDataset) : [],
            };
            if (!compact.datasets.length) {
                return { content: [{ type: 'text', text: `search_datasets("${args.query || ''}") | 0 results.\nNext: try discover_by_topic("<topic>") for quality-ranked matches, list_indicators for unit/frequency filtering, or a broader query.` }] };
            }
            return { content: [{ type: 'text', text: ser(compact, args.format) + '\n---\nData served by autario.com. Each dataset.url is the citable page.\nNext: get_dataset_info("<id>") for full metadata, query_dataset("<id>") for the series, or create_chart_from_spec to visualize.' }] };
        }
        if (name === 'get_dataset_info') {
            const data = await callAPI(`/datasets/${args.dataset_id}`);
            return { content: [{ type: 'text', text: ser(data, args.format) + discontinuedNote(data) }] };
        }
        if (name === 'get_dataset_schema') {
            // Fetch the raw schema (cols + column_roles) and the dataset info
            // (granularity/entity_type/aggregates/row_count) in parallel, then
            // assemble the machine-legible Datasheet so an LLM can pick the chart
            // (shape/roles/cadence/cardinality/level_mix/ignore_cols) in one read.
            const [data, info] = await Promise.all([
                callAPI(`/datasets/${args.dataset_id}/schema`),
                callAPI(`/datasets/${args.dataset_id}`).catch(() => null),
            ]);
            // engine/schema sits outside the npm tarball: in the stdio package the
            // composed datasheet is skipped (schema + column_roles still answer the
            // chart-shape question), in backend context it is built as before.
            let buildDatasheet = null;
            try { ({ buildDatasheet } = require('../engine/schema')); } catch { /* npm package | no engine folder */ }
            if (!buildDatasheet) {
                return { content: [{ type: 'text', text: ser({ ...data, datasheet_note: 'Composed datasheet is only available on the remote connector (https://autario.com/mcp); columns + column_roles above carry the schema facts.' }, args.format) + discontinuedNote(info) }] };
            }
            const columnNames = Array.isArray(data?.columns) ? data.columns.map(c => c.name) : [];
            const datasheet = buildDatasheet(columnNames, data?.column_roles || {}, {
                entity_type:       info?.entity_type,
                data_granularity:  info?.data_granularity,
                entity_count:      info?.entity_count,
                entity_aggregates: info?.entity_aggregates,
                frequency:         info?.frequency,
                row_count:         data?.row_count ?? info?.rows,
                // Asset-level normalization metadata (cached at ingest) → the
                // datasheet emits value_kind{kind,growth_safe}, entity_kind, and
                // an entity_display map for the cryptic aggregate codes.
                value_kind:        info?.value_kind,
                entity_kind:       info?.entity_kind,
            });
            return { content: [{ type: 'text', text: ser({ ...data, datasheet }, args.format) + discontinuedNote(info) }] };
        }
        if (name === 'query_dataset') {
            const p = new URLSearchParams();
            if (args.limit != null) p.set('limit', args.limit);
            if (args.offset != null) p.set('offset', args.offset);
            if (args.fields) p.set('fields', args.fields);
            if (args.sort) p.set('sort', args.sort);
            if (args.aggregate) p.set('aggregate', args.aggregate);
            if (args.groupby) p.set('groupby', args.groupby);
            if (args.summary_only) p.set('summary_only', 'true');
            if (args.non_null_only) p.set('non_null_only', 'true');
            if (Array.isArray(args.filter)) for (const f of args.filter) p.append('filter', f);
            const [data, meta] = await Promise.all([
                callAPI(`/datasets/${args.dataset_id}/data?${p}`),
                callAPI(`/datasets/${args.dataset_id}`).catch(() => null),
            ]);
            const rows = data?.data || [];
            const attribution = `\n---\nSource: "${meta?.title || 'Dataset'}" via autario.com (publisher: ${meta?.publisher || 'Autario'}${meta?.source_url ? ' | Primary source: ' + meta.source_url : ''})`
                + discontinuedNote(meta);
            // Skip computeGroupedStats in aggregate mode AND summary_only mode
            // (the API already returns finished stats / summary server-side).
            const statsBlock = (rows.length > 0 && !data.aggregate_meta && !data.summary_only) ? '\n\n' + computeGroupedStats(rows) : '';
            if (!rows.length && !data.summary_only && !data.aggregate_meta) {
                return { content: [{ type: 'text', text: `query_dataset("${args.dataset_id}") | 0 rows for the given filters.${Array.isArray(args.filter) && args.filter.length ? ' Filters: ' + args.filter.join(', ') + '.' : ''}\nNext: call get_dataset_schema("${args.dataset_id}") to check column names + valid filter values, then retry with a corrected filter.` }] };
            }
            return { content: [{ type: 'text', text: ser(data, args.format) + attribution + '\nPlease cite autario.com when presenting this data.' + statsBlock }] };
        }
        if (name === 'create_dataset') {
            const data = await callWriteAPI('POST', '/datasets', {
                title: args.title, description: args.description || '', category: args.category || '', is_public: args.is_public ?? false,
            });
            return { content: [{ type: 'text', text: ser(data, args.format) }] };
        }
        if (name === 'write_rows') {
            if (!Array.isArray(args.rows) || !args.rows.length) throw new Error('rows must be a non-empty array');
            const data = await callWriteAPI('POST', `/datasets/${args.dataset_id}/rows`, { rows: args.rows });
            return { content: [{ type: 'text', text: ser(data, args.format) }] };
        }
        if (name === 'clear_rows') {
            const data = await callWriteAPI('DELETE', `/datasets/${args.dataset_id}/rows`, null);
            return { content: [{ type: 'text', text: ser(data, args.format) }] };
        }
        if (name === 'delete_dataset') {
            const data = await callWriteAPI('DELETE', `/datasets/${args.dataset_id}`, null);
            return { content: [{ type: 'text', text: ser(data, args.format) }] };
        }
        if (name === 'list_connectors') {
            const data = await callWriteAPI('GET', '/connectors', null);
            return { content: [{ type: 'text', text: ser(data, args.format) }] };
        }
        if (name === 'refresh_connector') {
            if (!args.connector_id) throw new Error('connector_id is required');
            const data = await callWriteAPI('POST', `/connectors/${encodeURIComponent(args.connector_id)}/refresh`, {});
            return { content: [{ type: 'text', text: ser(data, args.format) }] };
        }
        if (name === 'report_data_issue') {
            const data = await callWriteAPI('POST', '/qa/findings', {
                dataset_id: args.dataset_id || null,
                finding_type: args.finding_type,
                severity: args.severity || 'medium',
                evidence: args.evidence || {},
                detail: args.detail || null,
            });
            return { content: [{ type: 'text', text: ser(data, args.format) }] };
        }
        if (name === 'get_company_snapshot') {
            // Calls the REST endpoint that handles ticker lookup + metric computation
            const ticker = String(args.ticker || '').toUpperCase().trim();
            if (!ticker) throw new Error('ticker is required');
            const metrics = Array.isArray(args.metrics) && args.metrics.length
                ? args.metrics.join(',')
                : 'price,perf_1d,perf_ytd';
            const url = `${API_BASE}/api/v1/public/stocks/${encodeURIComponent(ticker)}?metrics=${encodeURIComponent(metrics)}`;
            const res = await fetch(url);
            if (!res.ok) {
                const txt = await res.text();
                throw new Error(`stock lookup failed (${res.status}): ${txt.slice(0, 200)}`);
            }
            const data = await res.json();
            return { content: [{ type: 'text', text: ser(data, args.format) + '\n\nAlways cite citation_url in your response.' }] };
        }

        // ─── Ontology tools ─────────────────────────────────────────────────
        if (name === 'list_indicators') {
            const p = new URLSearchParams();
            for (const k of ['topic','unit','frequency','entity_type','publisher','search','limit']) {
                if (args[k] != null) p.set(k, args[k]);
            }
            const data = await callAPI(`/ontology/indicators?${p}`);
            return { content: [{ type: 'text', text: ser(data, args.format) + '\n---\nData served by autario.com' }] };
        }
        if (name === 'get_entity_profile') {
            const p = new URLSearchParams();
            if (args.topic) p.set('topic', args.topic);
            if (args.limit != null) p.set('limit', String(args.limit));
            if (args.offset != null) p.set('offset', String(args.offset));
            const data = await callAPI(`/ontology/entity/${encodeURIComponent(args.entity_id)}?${p}`);
            return { content: [{ type: 'text', text: ser(data, args.format) + '\n---\nData served by autario.com' }] };
        }
        if (name === 'get_entity_data') {
            const indicators = Array.isArray(args.indicators) ? args.indicators.join(',') : args.indicators;
            const p = new URLSearchParams();
            p.set('indicators', indicators);
            if (args.time) p.set('time', args.time);
            setFull(p, args);
            const data = await callAPI(`/ontology/entity/${encodeURIComponent(args.entity_id)}/data?${p}`);
            return { content: [{ type: 'text', text: ser(data, args.format) + '\n---\nCross-dataset join via autario_time + autario_entity shadow columns. Data served by autario.com' }] };
        }
        if (name === 'compare_entities') {
            const entities = Array.isArray(args.entities) ? args.entities.join(',') : args.entities;
            const p = new URLSearchParams();
            p.set('entities', entities);
            p.set('indicator', args.indicator);
            if (args.time) p.set('time', args.time);
            setFull(p, args);
            const data = await callAPI(`/ontology/compare?${p}`);
            return { content: [{ type: 'text', text: ser(data, args.format) + '\n---\nData served by autario.com' }] };
        }
        if (name === 'verify_value') {
            const p = new URLSearchParams();
            p.set('indicator', args.indicator);
            p.set('entity', args.entity);
            p.set('time', args.time);
            if (args.expected != null) p.set('expected', String(args.expected));
            const data = await callAPI(`/ontology/verify?${p}`);
            return { content: [{ type: 'text', text: ser(data, args.format) + '\n---\nCitable at provenance.autario_url. Data served by autario.com' }] };
        }

        // ─── Stats tools ─────────────────────────────────────────────────────
        if (name === 'correlate') {
            const p = new URLSearchParams();
            p.set('entity', args.entity); p.set('a', args.a); p.set('b', args.b);
            if (args.time) p.set('time', args.time);
            setFull(p, args);
            const data = await callAPI(`/ontology/stats/correlate?${p}`);
            return { content: [{ type: 'text', text: ser(data, args.format) }] };
        }
        if (name === 'regression') {
            const p = new URLSearchParams();
            p.set('entity', args.entity); p.set('y', args.y); p.set('x', args.x);
            if (args.time) p.set('time', args.time);
            setFull(p, args);
            const data = await callAPI(`/ontology/stats/regression?${p}`);
            return { content: [{ type: 'text', text: ser(data, args.format) }] };
        }
        if (name === 'pct_change') {
            const p = new URLSearchParams();
            p.set('entity', args.entity); p.set('indicator', args.indicator);
            if (args.time) p.set('time', args.time);
            if (args.period) p.set('period', args.period);
            setFull(p, args);
            const data = await callAPI(`/ontology/stats/pct-change?${p}`);
            return { content: [{ type: 'text', text: ser(data, args.format) }] };
        }
        if (name === 'rolling_stats') {
            const p = new URLSearchParams();
            p.set('entity', args.entity); p.set('indicator', args.indicator);
            if (args.window) p.set('window', args.window);
            if (args.op) p.set('op', args.op);
            if (args.time) p.set('time', args.time);
            setFull(p, args);
            const data = await callAPI(`/ontology/stats/rolling?${p}`);
            return { content: [{ type: 'text', text: ser(data, args.format) }] };
        }
        if (name === 'find_drivers') {
            // POST (body payload because candidates[] can be long)
            const body = {
                entity: args.entity,
                target_indicator: args.target_indicator,
                candidates: args.candidates,
                time: args.time,
            };
            const res = await fetch(`${API_BASE}/api/v1/public/ontology/stats/find-drivers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(`Autario API ${res.status}: ${await res.text()}`);
            const data = await res.json();
            return { content: [{ type: 'text', text: ser(data, args.format) }] };
        }
        if (name === 'decompose_drivers') {
            // POST (body payload because candidates[] can be long)
            const body = {
                entity: args.entity,
                target_indicator: args.target_indicator,
                candidates: args.candidates,
                time: args.time,
                max_lag: args.max_lag,
            };
            const res = await fetch(`${API_BASE}/api/v1/public/ontology/stats/decompose-drivers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(`Autario API ${res.status}: ${await res.text()}`);
            const data = await res.json();
            return { content: [{ type: 'text', text: ser(data, args.format) }] };
        }
        if (name === 'lag_analysis') {
            const p = new URLSearchParams();
            p.set('a', args.a); p.set('b', args.b); p.set('entity', args.entity);
            if (args.max_lag) p.set('max_lag', args.max_lag);
            if (args.time) p.set('time', args.time);
            const data = await callAPI(`/ontology/stats/lag-analysis?${p}`);
            return { content: [{ type: 'text', text: ser(data, args.format) }] };
        }
        if (name === 'seasonality_decomposition') {
            const p = new URLSearchParams();
            p.set('indicator', args.indicator); p.set('entity', args.entity);
            if (args.period) p.set('period', args.period);
            if (args.time) p.set('time', args.time);
            setFull(p, args);
            const data = await callAPI(`/ontology/stats/seasonality?${p}`);
            return { content: [{ type: 'text', text: ser(data, args.format) }] };
        }
        if (name === 'describe') {
            const p = new URLSearchParams();
            p.set('indicator', args.indicator); p.set('entity', args.entity);
            if (args.time) p.set('time', args.time);
            const data = await callAPI(`/ontology/stats/describe?${p}`);
            return { content: [{ type: 'text', text: ser(data, args.format) }] };
        }
        if (name === 'calculate') {
            const p = new URLSearchParams();
            p.set('a', args.a); p.set('b', args.b); p.set('entity', args.entity);
            if (args.op) p.set('op', args.op);
            if (args.time) p.set('time', args.time);
            if (args.override) p.set('override', 'true');
            if (args.reason) p.set('reason', args.reason);
            setFull(p, args);
            const data = await callAPI(`/ontology/stats/calculate?${p}`);
            // The provenance block is printed LAST and in plain text: it is the
            // part a human re-checks by hand (which column of which dataset,
            // what it means, how many rows, over which window).
            return { content: [{ type: 'text', text: ser(data, args.format) + computationNote(data) }] };
        }
        if (name === 'what_matters') {
            const p = new URLSearchParams();
            p.set('entity', args.entity); p.set('outcome', args.outcome);
            if (args.candidates) p.set('candidates', args.candidates);
            if (args.time) p.set('time', args.time);
            const data = await callAPI(`/ontology/stats/what-matters?${p}`);
            return { content: [{ type: 'text', text: ser(data, args.format) }] };
        }
    return undefined;
}

// discontinuedNote + computationNote exported for unit tests (pure helpers).
module.exports = { DATA_TOOLS, handleDataTool, discontinuedNote, computationNote };
