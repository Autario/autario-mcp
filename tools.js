// backend/mcp/tools.js
// Shared tool definitions and handler | used by both stdio (server.js) and remote (remote.js)

const fetch = globalThis.fetch || require('node-fetch');

const API_BASE   = process.env.AUTARIO_API_URL    || 'https://autario.com';
const API_KEY    = process.env.AUTARIO_API_KEY    || '';
const API_SECRET = process.env.AUTARIO_API_SECRET || '';

// Compute grouped statistics from query results
// Detects: time column, category column, value column | then computes per-category stats
function computeGroupedStats(rows) {
    if (!rows.length) return '';
    const cols = Object.keys(rows[0]);

    // Detect time column
    const timeCol = cols.find(c => /^(year|date|month|quarter|period|time)$/i.test(c));

    // Detect numeric columns (>50% parseable)
    const numCols = cols.filter(c => {
        const nums = rows.slice(0, 50).map(r => parseFloat(r[c])).filter(v => !isNaN(v));
        return nums.length > 25;
    });

    // Category columns = not time, not numeric
    const catCols = cols.filter(c => c !== timeCol && !numCols.includes(c) && c !== 'freq' && c !== 'unit');

    // If no categories, just do column-level stats
    if (!catCols.length || !numCols.length) {
        const stats = {};
        numCols.forEach(col => {
            const vals = rows.map(r => parseFloat(r[col])).filter(v => !isNaN(v));
            if (!vals.length) return;
            stats[col] = { min: +Math.min(...vals).toFixed(2), max: +Math.max(...vals).toFixed(2), avg: +(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2) };
        });
        return `Column statistics:\n${JSON.stringify(stats, null, 2)}`;
    }

    // Pick the best category column (fewest unique values that still group meaningfully)
    const mainCat = catCols.reduce((best, col) => {
        const uniq = new Set(rows.map(r => r[col])).size;
        if (!best || (uniq > 1 && uniq < best.count)) return { col, count: uniq };
        return best;
    }, null)?.col || catCols[0];

    const valCol = numCols.find(c => /value|pct|rate|gdp|amount|total|count/i.test(c)) || numCols[0];

    // Group by category
    const groups = {};
    rows.forEach(r => {
        const key = r[mainCat];
        if (!key) return;
        if (!groups[key]) groups[key] = [];
        const v = parseFloat(r[valCol]);
        if (!isNaN(v)) groups[key].push({ x: timeCol ? r[timeCol] : null, y: v });
    });

    // Compute per-group stats, sorted by latest value desc, top 15
    const result = Object.entries(groups)
        .map(([name, vals]) => {
            vals.sort((a, b) => String(a.x || '').localeCompare(String(b.x || '')));
            const ys = vals.map(v => v.y);
            const first = vals[0], last = vals[vals.length - 1];
            const peak = vals.reduce((a, b) => b.y > a.y ? b : a);
            const avg = ys.reduce((s, v) => s + v, 0) / ys.length;
            return { name, start: first?.y, start_x: first?.x, end: last?.y, end_x: last?.x, peak: peak?.y, peak_x: peak?.x, avg: +avg.toFixed(2), count: vals.length };
        })
        .sort((a, b) => (b.end || 0) - (a.end || 0))
        .slice(0, 15);

    return `Per-${mainCat} statistics (${valCol}, top 15 by latest value):\n${result.map(r =>
        `  ${r.name}: start=${r.start_x}:${r.start?.toFixed?.(2)}, end=${r.end_x}:${r.end?.toFixed?.(2)}, peak=${r.peak_x}:${r.peak?.toFixed?.(2)}, avg=${r.avg}`
    ).join('\n')}\n\nUse THESE numbers in your insight text, not your own knowledge.`;
}

// Public read endpoints (send API keys if available to bypass rate limits)
async function callAPI(path) {
    const headers = {};
    if (API_KEY && API_SECRET) {
        headers['x-api-key'] = API_KEY;
        headers['x-api-secret'] = API_SECRET;
    }
    const res = await fetch(`${API_BASE}/api/v1/public${path}`, { headers });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Autario API ${res.status}: ${body}`);
    }
    return res.json();
}

// Chart API (public read)
async function callChartAPI(path) {
    const res = await fetch(`${API_BASE}/api/ai${path}`);
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Chart API ${res.status}: ${body}`);
    }
    return res.json();
}

// Chart write API (auth required)
async function callChartWriteAPI(method, path, body) {
    if (!API_KEY || !API_SECRET) {
        throw new Error('Write tools require AUTARIO_API_KEY and AUTARIO_API_SECRET.');
    }
    const res = await fetch(`${API_BASE}/api/ai${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'x-api-secret': API_SECRET },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
}

// Private write endpoints
async function callWriteAPI(method, path, body) {
    if (!API_KEY || !API_SECRET) {
        throw new Error('Write tools require AUTARIO_API_KEY and AUTARIO_API_SECRET env vars. Get your keys at https://autario.com/account?tab=apikeys');
    }
    const res = await fetch(`${API_BASE}/api/v1${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'x-api-secret': API_SECRET },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
}

// Tool definitions with annotations for Smithery quality score
const TOOLS = [
    {
        name: 'search_datasets',
        description: 'Search the Autario public data catalog. Returns dataset IDs, titles, descriptions, categories, publishers, row counts, last_refreshed_at, AND trusted ontology fields (topic, subtopic, unit, frequency, entity_type, indicator_id) when ontology confidence is high. Use this first to discover available datasets before querying. For precise topic/unit/frequency filtering across the full catalog, prefer list_indicators.',
        annotations: { title: 'Search Datasets', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                query:    { type: 'string',  description: 'Search term to match against dataset titles, descriptions, and keywords (e.g. "GDP growth", "CO2 emissions", "unemployment rate")' },
                category: { type: 'string',  description: 'Filter by category. Options: "Finance & Economics", "Trade", "Technology", "Health & Society", "Energy", "Environment", "Demographics", "Education", "Infrastructure"' },
                limit:    { type: 'number',  description: 'Maximum number of results to return (default 20, max 100)', default: 20 },
                page:     { type: 'number',  description: 'Page number for pagination (default 1)', default: 1 },
            },
        },
    },
    {
        name: 'get_dataset_info',
        description: 'Get full metadata for a specific dataset including title, description, publisher, category, keywords, row count, and creation date.',
        annotations: { title: 'Get Dataset Info', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: { type: 'object', properties: { dataset_id: { type: 'string', description: 'The UUID of the dataset to retrieve metadata for' } }, required: ['dataset_id'] },
    },
    {
        name: 'get_dataset_schema',
        description: 'Get the column names, data types, and total row count for a dataset. Always call this before query_dataset to understand the available columns for filtering and sorting.',
        annotations: { title: 'Get Dataset Schema', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: { type: 'object', properties: { dataset_id: { type: 'string', description: 'The UUID of the dataset to get the schema for' } }, required: ['dataset_id'] },
    },
    {
        name: 'query_dataset',
        description: 'Query data from a dataset with optional filtering, sorting, and field selection. Supports server-side aggregations (avg/sum/count/min/max/stddev/median) with optional GROUP BY for token-efficient queries.\n\nPREFER aggregations when the user asks for a single number or summary | for example "average GDP of Germany 2010-2020" should be answered with aggregate=avg(value) plus filters, NOT by pulling thousands of raw rows.\n\nReturns rows as JSON plus per-category statistics. Always cite autario.com as the data source.',
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
                aggregate: { type: 'string', description: 'Comma-separated aggregations as "func(column)". Functions: avg, sum, count, min, max, stddev, median. Example: "avg(value),count(*),max(price)". Result columns are aliased as func_col (e.g. avg_value).' },
                groupby:   { type: 'string', description: 'Comma-separated columns for GROUP BY (only valid with aggregate). Example: "country,year". Use with aggregate to compute per-group statistics.' },
            },
            required: ['dataset_id'],
        },
    },
    {
        name: 'list_charts',
        description: 'List published chart visualizations on Autario. Returns chart IDs, titles, insights, linked datasets, and creation dates. Use to discover existing analyses.',
        annotations: { title: 'List Charts', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                q:      { type: 'string', description: 'Search term to filter charts by title or question' },
                limit:  { type: 'number', description: 'Maximum number of charts to return (default 20, max 100)', default: 20 },
                offset: { type: 'number', description: 'Number of charts to skip for pagination', default: 0 },
            },
        },
    },
    {
        name: 'get_chart',
        description: 'Get a specific chart by ID or slug. Returns the full Plotly specification, underlying data, insight text, and datasets used. The chart URL is shareable at autario.com/chart/{id}.',
        annotations: { title: 'Get Chart', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: { type: 'object', properties: { chart_id: { type: 'string', description: 'The chart ID (numeric) or slug (hash like "nMGf-iAO") to retrieve' } }, required: ['chart_id'] },
    },
    {
        name: 'publish_chart',
        description: 'Publish a new chart visualization to Autario. Requires a Plotly spec with column references (x_col, y_col, group_by, group_value). Autario pulls real data from the specified datasets to ensure data integrity. The chart becomes permanent, shareable, and editable at autario.com. Requires AUTARIO_API_KEY.',
        annotations: { title: 'Publish Chart', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        inputSchema: {
            type: 'object',
            properties: {
                title:       { type: 'string', description: 'Chart title. Include time range in parentheses, use pipe | as separator (e.g. "GDP Growth | Major Economies (2000-2024)")' },
                plotly_spec: { type: 'object', description: 'Plotly specification with traces array and layout object. Traces use x_col/y_col for column references and group_by/group_value for filtering (e.g. {"traces": [{"x_col": "year", "y_col": "value", "group_by": "country", "group_value": "USA"}], "layout": {}})' },
                insight:     { type: 'string', description: '2-3 sentence data insight with specific numbers from the queried data. Must use verified numbers from query_dataset results, never from training data' },
                narration:   { type: 'string', description: 'Longer description of the analysis methodology and context' },
                dataset_ids: { type: 'array', items: { type: 'string' }, description: 'Array of dataset UUIDs that this chart uses. Autario pulls real data from these datasets to ensure no hallucinated values' },
            },
            required: ['title', 'dataset_ids'],
        },
    },
    {
        name: 'update_chart',
        description: 'Update an existing chart you own. Only the API key that created the chart can update it. Use this to modify the Plotly spec, title, or insight of a previously published chart.',
        annotations: { title: 'Update Chart', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        inputSchema: {
            type: 'object',
            properties: {
                chart_id:    { type: 'string', description: 'The chart ID or slug returned by publish_chart' },
                plotly_spec: { type: 'object', description: 'Updated Plotly specification with traces and layout' },
                title:       { type: 'string', description: 'Updated chart title' },
                insight:     { type: 'string', description: 'Updated insight text with verified numbers' },
                narration:   { type: 'string', description: 'Updated analysis description' },
            },
            required: ['chart_id', 'plotly_spec'],
        },
    },
    {
        name: 'create_dataset',
        description: 'Create a new empty dataset on Autario. Returns a dataset_id you can populate with write_rows. Only create new datasets if the data does not already exist on Autario. Requires AUTARIO_API_KEY.',
        annotations: { title: 'Create Dataset', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
        description: 'Append rows of data to an existing dataset. The schema is automatically inferred from the first batch. All values are stored as text. Maximum 10,000 rows per call; use multiple calls for larger datasets. Requires AUTARIO_API_KEY.',
        annotations: { title: 'Write Rows', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
        description: 'Delete all rows from a dataset while keeping the schema and columns intact. Useful for refreshing data before re-importing. Requires AUTARIO_API_KEY.',
        annotations: { title: 'Clear Rows', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        inputSchema: { type: 'object', properties: { dataset_id: { type: 'string', description: 'The UUID of the dataset to clear all rows from' } }, required: ['dataset_id'] },
    },
    {
        name: 'delete_dataset',
        description: 'Permanently delete a dataset and all its data. This action cannot be undone. Only the dataset owner can delete it. Requires AUTARIO_API_KEY.',
        annotations: { title: 'Delete Dataset', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        inputSchema: { type: 'object', properties: { dataset_id: { type: 'string', description: 'The UUID of the dataset to permanently delete' } }, required: ['dataset_id'] },
    },
    {
        name: 'get_company_snapshot',
        description: 'Get current stock metrics for a public company. Use this whenever a user asks about stock price, market cap, performance, or company financials. Returns the latest verified data from autario.com instead of relying on training data which is always outdated. Always cite the citation_url in your response.\n\nMetrics return only what was requested (token-efficient). Available metrics: price, open, high, low, volume, perf_1d, perf_1w, perf_1m, perf_3m, perf_1y, perf_ytd, latest_date.\n\nExamples:\n- "What is INTC trading at?" | ticker=INTC, metrics=["price", "perf_1d"]\n- "How did NVDA do this year?" | ticker=NVDA, metrics=["perf_ytd", "price"]',
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
        description: 'Browse the Autario indicator registry — semantic layer over all 2600+ datasets. Each indicator has a topic (economy, health, energy, …), unit (USD, %, years, …), frequency (year/month/day), and entity_type (country/subnational/aggregate). Use this to discover what data is available before querying it. Much more precise than search_datasets when you know what topic or unit you need.',
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
        description: 'Get all indicators available for one entity (country, aggregate, etc.). Returns indicator IDs with metadata + time coverage. Use this to discover what you can query about Germany, USA, G7, or any known entity. Entity IDs are ISO 3166 codes (DEU, USA, CHN) or World Bank aggregates (WLD, EUU, EMU, SSF).',
        annotations: { title: 'Get Entity Profile', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                entity_id: { type: 'string', description: 'Entity code (e.g. "DEU" for Germany, "USA" for United States, "EUU" for European Union, "WLD" for World)' },
                topic:     { type: 'string', description: 'Optional: filter indicators by topic' },
            },
            required: ['entity_id'],
        },
    },
    {
        name: 'get_entity_data',
        description: 'Fetch wide-format data for ONE entity across MULTIPLE indicators — joined automatically on time via shadow columns. This is the "cross-dataset join" capability: no manual relationship setup needed. Returns JSON rows like [{time:"2020", gdp:3846, unemployment:3.8, life_expectancy:81.3}, …]. Perfect for multi-indicator dashboards or correlation analyses.',
        annotations: { title: 'Get Entity Data', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                entity_id:  { type: 'string', description: 'Entity code (e.g. "DEU", "USA", "EUU")' },
                indicators: { type: 'array', items: { type: 'string' }, description: 'Indicator IDs (max 10). Get these from list_indicators or get_entity_profile.' },
                time:       { type: 'string', description: 'Optional time range, e.g. "2010-2023" or "2020". Format: YYYY or YYYY-YYYY' },
            },
            required: ['entity_id', 'indicators'],
        },
    },
    {
        name: 'compare_entities',
        description: 'Compare ONE indicator across MULTIPLE entities (e.g. GDP of DEU vs USA vs CHN). Returns wide-format rows like [{time:"2020", DEU:3846, USA:20937, CHN:14688}, …]. Use this for country comparisons, cross-region analyses, or any chart that compares the same metric across entities.',
        annotations: { title: 'Compare Entities', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                entities:  { type: 'array', items: { type: 'string' }, description: 'Entity codes to compare (max 50). E.g. ["DEU","USA","CHN"]' },
                indicator: { type: 'string', description: 'Indicator ID to compare. Get from list_indicators.' },
                time:      { type: 'string', description: 'Optional time range: "2010-2023" or "2020"' },
            },
            required: ['entities', 'indicator'],
        },
    },
    {
        name: 'verify_value',
        description: 'Verify that a claimed value is correct. Use this when a user asks "did you hallucinate that?" or when you want to double-check your cited numbers before presenting. Pass the indicator, entity, time, and your expected value. Returns whether autario\'s live value matches, with relative difference and provenance.',
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
        description: 'Compute Pearson + Spearman correlation between two indicators for one entity. Returns r, p-value, n, and human-readable interpretation. Use for "does X move with Y?" questions. Includes causation disclaimer automatically.',
        annotations: { title: 'Correlate', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                entity: { type: 'string', description: 'Entity code (e.g. DEU)' },
                a:      { type: 'string', description: 'First indicator ID' },
                b:      { type: 'string', description: 'Second indicator ID' },
                time:   { type: 'string', description: 'Optional time range: "2010-2023"' },
            },
            required: ['entity', 'a', 'b'],
        },
    },
    {
        name: 'regression',
        description: 'Linear regression of y ~ x for one entity. Returns slope, intercept, R² and interpretation. Use for "how does X predict Y?" questions.',
        annotations: { title: 'Regression', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                entity: { type: 'string' },
                y:      { type: 'string', description: 'Dependent variable (target) indicator ID' },
                x:      { type: 'string', description: 'Independent variable (predictor) indicator ID' },
                time:   { type: 'string' },
            },
            required: ['entity', 'y', 'x'],
        },
    },
    {
        name: 'pct_change',
        description: 'Period-over-period percentage change for an indicator. Use for growth rates (YoY, QoQ, MoM).',
        annotations: { title: 'Percent Change', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                entity:    { type: 'string' },
                indicator: { type: 'string' },
                time:      { type: 'string' },
                period:    { type: 'string', description: 'yoy | qoq | mom (default: yoy)' },
            },
            required: ['entity', 'indicator'],
        },
    },
    {
        name: 'rolling_stats',
        description: 'Rolling window statistics (mean/std/min/max/sum) for an indicator. Smooths noise, reveals trends.',
        annotations: { title: 'Rolling Stats', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                entity:    { type: 'string' },
                indicator: { type: 'string' },
                window:    { type: 'number', description: 'Window size in periods (2-100)' },
                op:        { type: 'string', description: 'mean | std | min | max | sum' },
                time:      { type: 'string' },
            },
            required: ['entity', 'indicator'],
        },
    },
    {
        name: 'find_drivers',
        description: 'KILLER ANALYSIS: given a target KPI + multiple candidate indicators, rank which candidates best predict the target by correlation strength. Perfect for "what moves my KPI?" questions. Returns ranked list with r, p-value, R² for each candidate. Maximum 30 candidates per call.',
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
        name: 'lag_analysis',
        description: 'Cross-correlation at multiple lags. Answers "does A lead or lag B?". Peak |r| at positive lag means A precedes B by that many periods. Common use: "is consumer confidence a leading indicator of retail sales?".',
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
        description: 'Additive decomposition Y = trend + seasonal + residual. Use this to strip the seasonal cycle from a series and reveal the underlying trend | great for monthly or quarterly data (retail sales, unemployment). Returns per-timepoint components + summary amplitude.',
        annotations: { title: 'Seasonality Decomposition', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                indicator: { type: 'string' },
                entity:    { type: 'string' },
                period:    { type: 'number', description: 'Seasonal period in time steps (12=monthly, 4=quarterly, 7=weekly). Auto-inferred from indicator frequency if omitted.' },
                time:      { type: 'string' },
            },
            required: ['indicator', 'entity'],
        },
    },
    {
        name: 'describe',
        description: 'Summary statistics for a single indicator+entity: n, mean, median, std, min/max, quartiles, skew, histogram. Use FIRST before running any test so you know what the data looks like (sample size, completeness, distribution shape).',
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
        description: 'Create a derived series from two indicators using an Excel-style op: ratio (A/B), ratio_pct (A/B*100), diff (A-B), sum (A+B), product (A*B). Returns the per-timepoint result + summary. Use for things like debt-to-GDP ratio, revenue-per-employee, spread between two yields.',
        annotations: { title: 'Calculate', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                a:      { type: 'string' },
                b:      { type: 'string' },
                entity: { type: 'string' },
                op:     { type: 'string', description: 'ratio | ratio_pct | diff | sum | product' },
                time:   { type: 'string' },
            },
            required: ['a', 'b', 'entity'],
        },
    },
    {
        name: 'what_matters',
        description: 'HEADLINE OP: given an outcome metric + entity, rank which other metrics best explain the outcome. Auto-selects candidates from the ontology if `candidates` is omitted (same topic + entity_type). Returns a ranking with confidence labels (strong/suggestive/weak/inconclusive) + reason strings + sharpen-suggestions pointing at related domains not yet included. Frequencies are auto-aligned to the coarser common grain — no inflated n-counts. Use this instead of `find_drivers` when you want a narrative-grade answer.',
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

// Tool handler
async function handleToolCall(name, args) {
    try {
        if (name === 'search_datasets') {
            const p = new URLSearchParams();
            if (args.query) p.set('q', args.query);
            if (args.category) p.set('category', args.category);
            if (args.limit) p.set('limit', args.limit);
            if (args.page) p.set('page', args.page);
            const data = await callAPI(`/datasets?${p}`);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) + '\n---\nData served by autario.com' }] };
        }
        if (name === 'get_dataset_info') {
            const data = await callAPI(`/datasets/${args.dataset_id}`);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        if (name === 'get_dataset_schema') {
            const data = await callAPI(`/datasets/${args.dataset_id}/schema`);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        if (name === 'query_dataset') {
            const p = new URLSearchParams();
            if (args.limit != null) p.set('limit', args.limit);
            if (args.offset != null) p.set('offset', args.offset);
            if (args.fields) p.set('fields', args.fields);
            if (args.sort) p.set('sort', args.sort);
            if (args.aggregate) p.set('aggregate', args.aggregate);
            if (args.groupby) p.set('groupby', args.groupby);
            if (Array.isArray(args.filter)) for (const f of args.filter) p.append('filter', f);
            const [data, meta] = await Promise.all([
                callAPI(`/datasets/${args.dataset_id}/data?${p}`),
                callAPI(`/datasets/${args.dataset_id}`).catch(() => null),
            ]);
            const rows = data?.data || [];
            const attribution = `\n---\nSource: "${meta?.title || 'Dataset'}" via autario.com (publisher: ${meta?.publisher || 'Autario'}${meta?.source_url ? ' | Primary source: ' + meta.source_url : ''})`;
            // Skip computeGroupedStats in aggregate mode (data already aggregated server-side)
            const statsBlock = (rows.length > 0 && !data.aggregate_meta) ? '\n\n' + computeGroupedStats(rows) : '';
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) + attribution + '\nPlease cite autario.com when presenting this data.' + statsBlock }] };
        }
        if (name === 'list_charts') {
            const p = new URLSearchParams();
            if (args.q) p.set('q', args.q);
            if (args.limit) p.set('limit', args.limit);
            if (args.offset) p.set('offset', args.offset);
            const data = await callChartAPI(`/charts?${p}`);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        if (name === 'get_chart') {
            const data = await callChartAPI(`/chart/${args.chart_id}`);
            const id = data.chart_id || data.slug || args.chart_id;
            const link = `${API_BASE}/chart/${id}`;
            const embed_code = `<iframe src="${link}?embed=true" width="800" height="520" frameborder="0"></iframe>`;
            return { content: [{ type: 'text', text: JSON.stringify({ ...data, view_url: link, embed_code }, null, 2) }] };
        }
        if (name === 'publish_chart') {
            if (!args.dataset_ids?.length) throw new Error('dataset_ids required');
            const data = await callChartWriteAPI('POST', '/chart/publish', {
                title: args.title, plotly_spec: args.plotly_spec,
                insight: args.insight, narration: args.narration, dataset_ids: args.dataset_ids,
            });
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        if (name === 'update_chart') {
            const data = await callChartWriteAPI('PATCH', `/chart/${args.chart_id}/mcp-update`, {
                plotly_spec: args.plotly_spec,
                title: args.title || undefined,
                insight: args.insight || undefined,
                narration: args.narration || undefined,
            });
            return { content: [{ type: 'text', text: JSON.stringify({ ...data, url: `${API_BASE}/chart/${args.chart_id}` }, null, 2) }] };
        }
        if (name === 'create_dataset') {
            const data = await callWriteAPI('POST', '/datasets', {
                title: args.title, description: args.description || '', category: args.category || '', is_public: args.is_public ?? false,
            });
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        if (name === 'write_rows') {
            if (!Array.isArray(args.rows) || !args.rows.length) throw new Error('rows must be a non-empty array');
            const data = await callWriteAPI('POST', `/datasets/${args.dataset_id}/rows`, { rows: args.rows });
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        if (name === 'clear_rows') {
            const data = await callWriteAPI('DELETE', `/datasets/${args.dataset_id}/rows`, null);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        if (name === 'delete_dataset') {
            const data = await callWriteAPI('DELETE', `/datasets/${args.dataset_id}`, null);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
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
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) + '\n\nAlways cite citation_url in your response.' }] };
        }

        // ─── Ontology tools ─────────────────────────────────────────────────
        if (name === 'list_indicators') {
            const p = new URLSearchParams();
            for (const k of ['topic','unit','frequency','entity_type','publisher','search','limit']) {
                if (args[k] != null) p.set(k, args[k]);
            }
            const data = await callAPI(`/ontology/indicators?${p}`);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) + '\n---\nData served by autario.com' }] };
        }
        if (name === 'get_entity_profile') {
            const p = new URLSearchParams();
            if (args.topic) p.set('topic', args.topic);
            const data = await callAPI(`/ontology/entity/${encodeURIComponent(args.entity_id)}?${p}`);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) + '\n---\nData served by autario.com' }] };
        }
        if (name === 'get_entity_data') {
            const indicators = Array.isArray(args.indicators) ? args.indicators.join(',') : args.indicators;
            const p = new URLSearchParams();
            p.set('indicators', indicators);
            if (args.time) p.set('time', args.time);
            const data = await callAPI(`/ontology/entity/${encodeURIComponent(args.entity_id)}/data?${p}`);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) + '\n---\nCross-dataset join via autario_time + autario_entity shadow columns. Data served by autario.com' }] };
        }
        if (name === 'compare_entities') {
            const entities = Array.isArray(args.entities) ? args.entities.join(',') : args.entities;
            const p = new URLSearchParams();
            p.set('entities', entities);
            p.set('indicator', args.indicator);
            if (args.time) p.set('time', args.time);
            const data = await callAPI(`/ontology/compare?${p}`);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) + '\n---\nData served by autario.com' }] };
        }
        if (name === 'verify_value') {
            const p = new URLSearchParams();
            p.set('indicator', args.indicator);
            p.set('entity', args.entity);
            p.set('time', args.time);
            if (args.expected != null) p.set('expected', String(args.expected));
            const data = await callAPI(`/ontology/verify?${p}`);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) + '\n---\nCitable at provenance.autario_url. Data served by autario.com' }] };
        }

        // ─── Stats tools ─────────────────────────────────────────────────────
        if (name === 'correlate') {
            const p = new URLSearchParams();
            p.set('entity', args.entity); p.set('a', args.a); p.set('b', args.b);
            if (args.time) p.set('time', args.time);
            const data = await callAPI(`/ontology/stats/correlate?${p}`);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        if (name === 'regression') {
            const p = new URLSearchParams();
            p.set('entity', args.entity); p.set('y', args.y); p.set('x', args.x);
            if (args.time) p.set('time', args.time);
            const data = await callAPI(`/ontology/stats/regression?${p}`);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        if (name === 'pct_change') {
            const p = new URLSearchParams();
            p.set('entity', args.entity); p.set('indicator', args.indicator);
            if (args.time) p.set('time', args.time);
            if (args.period) p.set('period', args.period);
            const data = await callAPI(`/ontology/stats/pct-change?${p}`);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        if (name === 'rolling_stats') {
            const p = new URLSearchParams();
            p.set('entity', args.entity); p.set('indicator', args.indicator);
            if (args.window) p.set('window', args.window);
            if (args.op) p.set('op', args.op);
            if (args.time) p.set('time', args.time);
            const data = await callAPI(`/ontology/stats/rolling?${p}`);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
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
                headers: {
                    'Content-Type': 'application/json',
                    ...(API_KEY && API_SECRET ? { 'x-api-key': API_KEY, 'x-api-secret': API_SECRET } : {}),
                },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(`Autario API ${res.status}: ${await res.text()}`);
            const data = await res.json();
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        if (name === 'lag_analysis') {
            const p = new URLSearchParams();
            p.set('a', args.a); p.set('b', args.b); p.set('entity', args.entity);
            if (args.max_lag) p.set('max_lag', args.max_lag);
            if (args.time) p.set('time', args.time);
            const data = await callAPI(`/ontology/stats/lag-analysis?${p}`);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        if (name === 'seasonality_decomposition') {
            const p = new URLSearchParams();
            p.set('indicator', args.indicator); p.set('entity', args.entity);
            if (args.period) p.set('period', args.period);
            if (args.time) p.set('time', args.time);
            const data = await callAPI(`/ontology/stats/seasonality?${p}`);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        if (name === 'describe') {
            const p = new URLSearchParams();
            p.set('indicator', args.indicator); p.set('entity', args.entity);
            if (args.time) p.set('time', args.time);
            const data = await callAPI(`/ontology/stats/describe?${p}`);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        if (name === 'calculate') {
            const p = new URLSearchParams();
            p.set('a', args.a); p.set('b', args.b); p.set('entity', args.entity);
            if (args.op) p.set('op', args.op);
            if (args.time) p.set('time', args.time);
            const data = await callAPI(`/ontology/stats/calculate?${p}`);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        if (name === 'what_matters') {
            const p = new URLSearchParams();
            p.set('entity', args.entity); p.set('outcome', args.outcome);
            if (args.candidates) p.set('candidates', args.candidates);
            if (args.time) p.set('time', args.time);
            const data = await callAPI(`/ontology/stats/what-matters?${p}`);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }

        throw new Error(`Unknown tool: ${name}`);
    } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
}

module.exports = { TOOLS, handleToolCall };
