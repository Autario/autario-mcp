// backend/mcp/tools-viz.js
// OWNED BY Track B (created by Track A First-Tick split; Track B owns ongoing)
// Viz tools: chart CRUD + publish + chart_instructions + update_chart.
// Definitions (VIZ_TOOLS) + handler (handleVizTool). Union assembled in tools.js.

const { callChartAPI, callChartWriteAPI, API_BASE, compactChart, ser, FORMAT_PROP } = require('./tools-common');

const VIZ_TOOLS = [
    {
        name: 'list_charts',
        description: 'List published chart visualizations on Autario, built on the public catalog (World Bank, FRED, Eurostat, OECD, WHO, IMF, SEC) and rendered with Plotly. Returns chart IDs, titles, insights, linked datasets, and creation dates. Use to discover existing analyses before building a new one, and to find a shareable autario.com/chart/{id} link for an answer.',
        annotations: { title: 'List Charts', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                q:      { type: 'string', description: 'Search term to filter charts by title or question' },
                limit:  { type: 'number', description: 'Maximum number of charts to return (default 20, max 100)', default: 20 },
                offset: { type: 'number', description: 'Number of charts to skip for pagination', default: 0 },
                ...FORMAT_PROP,
            },
        },
    },
    {
        name: 'list_chart_candidates',
        description: 'AUTARIO-INTERNAL chart queue (admin only): list catalog datasets (World Bank, FRED, Eurostat, OECD, WHO, IMF, SEC) that have NO published chart yet, ranked by relevance, so the content pipeline can fill the gap. Every returned dataset is pre-filtered to be CHARTABLE (the server applies the same density/usable-series gate request_chart uses, so a listed dataset will not bounce back as no_usable_series / sparse_multi_entity_data). Each item carries chartable (true) + chartable_reason for transparency. Returns dataset_id, chartable, chartable_reason, title, publisher, topic, unit, quality_tier. Work through each: request_chart (preferred) OR get_dataset_info -> get_dataset_schema -> query_dataset -> create_chart_from_spec. Non-admin keys receive 403. This is the queue for autario-generated charts; third parties do not need it.',
        // autarioAuthRequired: read-only, but admin-scoped | must trigger the
        // OAuth challenge instead of resolving against the server's env
        // identity (authz-matrix audit 2026-07-20).
        annotations: { title: 'List Chart Candidates (admin)', readOnlyHint: true, autarioAuthRequired: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'number', description: 'Max datasets to return (default 25, max 200)', default: 25 },
            },
        },
    },
    {
        name: 'get_chart',
        description: 'Get a specific chart by ID or slug. Returns a COMPACT, token-bounded summary (NOT the raw Plotly spec or full data arrays, which can be megabytes): title, insight/narration, datasets_used (with publisher), chart_type, the time/x range, and a PER-SERIES summary (first/latest/min/max/avg + point count, plus a small downsampled sample). For the full interactive chart and every data point, open view_url. The chart URL is shareable at autario.com/chart/{id}.',
        annotations: { title: 'Get Chart', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: { type: 'object', properties: { chart_id: { type: 'string', description: 'The chart ID (numeric) or slug (hash like "nMGf-iAO") to retrieve' }, ...FORMAT_PROP }, required: ['chart_id'] },
    },
    {
        name: 'chart_instructions',
        description: 'Get the Builder spec schema reference. Returns chart_type enum, required/optional fields per type, palette options, axis-override shape, annotation format, and concrete examples. Call this ONCE at session-start; the spec it returns is the input shape for create_chart_from_spec. Cheaper and clearer than guessing Plotly JSON syntax.',
        annotations: { title: 'Chart Builder Instructions', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'request_chart',
        description: 'AUTARIO-INTERNAL high-level chart request (admin only): the server builds the Plotly chart from a catalog dataset (World Bank, FRED, Eurostat, OECD, WHO, IMF, SEC), you do NOT build a spec, but you DO write the insight. TWO-STEP FLOW for a first-try hit: (1) PREPARE - call with dataset_id/query and NO insight; the server composes the chart deterministically and returns charted_entities (the exact entity set it drew, each with latest/peak/trough/average) + chart_type, WITHOUT publishing. IMPORTANT: a multi-country dataset is charted as an ENTITY FAMILY (the top economies, G7, the aggregate rows...), so your insight is verified ONLY against the entities actually in charted_entities | anchor every claim on one of THOSE entities and cite only THOSE per-entity values. (2) PUBLISH - call again with the same dataset_id/query PLUS your 2-3 sentence insight; the server verifies it against the real data (number-hallucination gate) and publishes, returning the URL. The server runs NO LLM of its own (you write the insight). One request = one chart. On reject it returns 422 naming WHICH number/claim failed + the charted_entities + available anchors so you fix in one step. Use THIS over create_chart_from_spec whenever you want "a good chart for this dataset/topic" without assembling a full Builder spec. Non-admin keys receive 403; third parties use create_chart_from_spec / publish_chart.',
        annotations: { title: 'Request Chart (server builds it)', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                dataset_id: { type: 'string', description: 'UUID of the dataset to chart (from search_datasets / discover_by_topic / list_chart_candidates). Preferred when you already know the dataset.' },
                query:      { type: 'string', description: 'Free-form topic/search string the server resolves to the best chartable dataset (e.g. "global inflation", "US unemployment rate"). Use instead of dataset_id when you only know the topic. dataset_id wins if both are given.' },
                insight:    { type: 'string', description: 'Your 2-3 sentence data insight. OMIT IT on the PREPARE call to receive charted_entities + anchors first; SEND IT on the PUBLISH call to verify + publish. Every cited number MUST be one of the per-entity values in charted_entities (latest/peak/trough/average) returned by the prepare call. The server verifies it against the real data and publishes on pass, or returns the failing number(s) + charted_entities + anchors on fail. The server does NOT write this for you.' },
                chart_type: { type: 'string', description: 'OPTIONAL hint (line | bar | snapshot). The server still owns the final chart-type decision based on the data shape; this is a soft preference only.' },
                region:     { type: 'string', description: 'OPTIONAL hint to focus a multi-country dataset on a region/entity (e.g. "G7", "Europe"). Soft preference; the server picks the final entity set.' },
                time:       { type: 'string', description: 'OPTIONAL time-range hint (e.g. "2010-2024"). Soft preference; the server uses the actual data span.' },
            },
            required: [],
        },
    },
    {
        name: 'create_chart_from_spec',
        description: 'PREFERRED chart-creation path, for any autario dataset (World Bank, FRED, Eurostat, OECD, SEC, or your own upload / connector table). Send a structured Builder spec (chart_type + x_col + y_col[s] + optional group_by, palette, axis overrides, annotations) and Autario renders the Plotly chart with the same templates the Builder UI uses. Brand attribution (publisher source + autario.com) is applied automatically and cannot be overridden. Insight must cite numbers verifiable against the data | hallucinated numbers return 422 with the available anchor list. For advanced use cases the Builder cannot express, fall back to publish_chart with a freeform plotly_spec. Call chart_instructions() first if unsure of the spec shape.',
        annotations: { title: 'Create Chart from Builder Spec', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                builder_spec: { type: 'object', description: 'Structured Builder spec. Required: chart_type + x_col + y_col/y_cols (axis charts), label_col + value_col (pie/donut), x_col + group_by + value_col (heatmap). Optional: group_by, group_values, facet_by/facet_values (donut grid), heatmap_scale, title, palette/color_scheme, axis (x_title, y_title, y_min, y_max, log_scale, y_format, tick_angle, x_date_format), annotations, event_bands, overlays, legend_pos, bg_color, font_color, chart_height. See chart_instructions() for full reference.' },
                title:        { type: 'string', description: 'Chart title (also settable via builder_spec.title; this top-level wins if both set). Format: "{Topic} | {Scope} ({YYYY-YYYY}, {unit})". The YYYY-YYYY year range is REQUIRED whenever the chart has a time axis (pull from the actual data span you queried). The unit is REQUIRED whenever get_dataset_info → unit is a non-empty string (copy verbatim, e.g. "Mt CO2e", "% of GDP", "per 1,000 live births"). If get_dataset_info → unit is null/empty, omit the unit | NEVER invent one. Example with both: "Greenhouse Gas Emissions by Country (2010-2024, Mt CO2e) | World Bank". Example unit-only: "Infant Mortality by Race (per 1,000 live births) | NCHS".' },
                insight:      { type: 'string', description: '2-3 sentence data insight using ONLY numbers from query_dataset/get_dataset_schema results. Hallucinated numbers are rejected with the available anchor list.' },
                narration:    { type: 'string', description: 'Longer description (optional, defaults to insight)' },
                dataset_ids:  { type: 'array', items: { type: 'string' }, description: 'UUID array of datasets backing this chart. Autario pulls real data from these tables.' },
            },
            required: ['builder_spec', 'dataset_ids'],
        },
    },
    {
        name: 'publish_chart',
        description: 'Publish a chart via freeform Plotly spec. Use create_chart_from_spec instead unless you need a Plotly feature the Builder spec doesn\'t cover (custom shapes, multi-axis layouts, animation frames). Requires AUTARIO_API_KEY. Brand attribution + insight verification gate apply identically to create_chart_from_spec.',
        annotations: { title: 'Publish Chart (legacy plotly_spec)', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
        // destructiveHint: an update REPLACES the stored spec of a chart that already has a
        // permanent public URL | the previous version is not recoverable through this tool.
        annotations: { title: 'Update Chart', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
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
];

// Returns the tool result, or undefined if `name` is not a viz tool. Throws on
// handler errors | the router in tools.js wraps + formats.
async function handleVizTool(name, args) {
        if (name === 'list_charts') {
            const p = new URLSearchParams();
            if (args.q) p.set('q', args.q);
            if (args.limit) p.set('limit', args.limit);
            if (args.offset) p.set('offset', args.offset);
            const data = await callChartAPI(`/charts?${p}`);
            const list = Array.isArray(data) ? data : (data?.charts ?? data?.data ?? null);
            if (Array.isArray(list) && list.length === 0) {
                return { content: [{ type: 'text', text: `list_charts(${args.q ? '"' + args.q + '"' : ''}) | 0 charts.\nNext: create one with create_chart_from_spec (call chart_instructions first for the builder_spec schema), or broaden the query.` }] };
            }
            return { content: [{ type: 'text', text: ser(data, args.format) + '\nNext: get_chart("<id_or_slug>") for the per-series summary + view_url, or update_chart to edit one.' }] };
        }
        if (name === 'list_chart_candidates') {
            const limit = Math.min(Math.max(parseInt(args.limit, 10) || 25, 1), 200);
            // GET via the write-API helper so the admin auth headers ride along;
            // the endpoint itself enforces isAdminFn (CURATOR_EMAIL) and 403s others.
            const data = await callChartWriteAPI('GET', `/charts/candidates?limit=${limit}`);
            return { content: [{ type: 'text', text: ser(data, args.format) }] };
        }
        if (name === 'get_chart') {
            // The /chart/:id API returns the WHOLE chart (full plotly_spec traces
            // with raw x[]/y[] arrays + layout/styling + raw data rows) | for a
            // multi-entity comparison that is megabytes and blows up the LLM
            // context. compactChart() bounds it to a per-series summary + view_url
            // (defensive: never throws, never returns the raw bomb).
            const data = await callChartAPI(`/chart/${args.chart_id}`);
            const compact = compactChart(data, { apiBase: API_BASE });
            // Locked private charts come back as a minimal payload (no series) |
            // surface that explicitly so the LLM doesn't treat it as an empty chart.
            if (data && data.locked) {
                return { content: [{ type: 'text', text: ser({ chart_id: data.chart_id ?? args.chart_id, slug: data.slug || undefined, locked: true, is_public: false, view_url: compact.view_url, note: 'This chart is private; only its owner can view it.' }, args.format || 'compact') }] };
            }
            // get_chart pins to compact JSON by default: the per-series summary is
            // nested (TOON would degrade to embedded JSON anyway) and this is the
            // primary number-citation surface. Caller can still force toon/json.
            return { content: [{ type: 'text', text: ser(compact, args.format || 'compact') }] };
        }
        if (name === 'chart_instructions') {
            // Static schema reference | no API call. Tells the agent the
            // exact shape of `builder_spec` that create_chart_from_spec
            // accepts. Niko's vision (May 2026): one self-describing tool
            // means the agent doesn't have to grep tool descriptions or
            // guess Plotly syntax.
            const { CHART_INSTRUCTIONS } = require('./chartInstructions');
            return { content: [{ type: 'text', text: ser(CHART_INSTRUCTIONS, args.format) }] };
        }
        if (name === 'request_chart') {
            if (!args.dataset_id && !(args.query && String(args.query).trim())) {
                throw new Error('request_chart needs dataset_id OR query (a free-form topic to resolve a dataset).');
            }
            // insight is OPTIONAL here: omit it for the PREPARE call (server returns
            // charted_entities + anchors, no publish), send it for the PUBLISH call.
            // The server runs NO LLM on either path (Niko-Gesetz: no externally-
            // triggered server-LLM cost) | it composes deterministically and, when
            // an insight is sent, verifies it against the real data before publishing.
            // Thin wrapper over the admin-only HTTP endpoint that runs the
            // DETERMINISTIC compose + number-verify gate + publish server-side. We
            // send the high-level request + the caller insight; the server slices
            // the data, verifies the insight (no server LLM), publishes and returns
            // the URL. Compact text result so the LLM sees the outcome immediately.
            const data = await callChartWriteAPI('POST', '/chart/request', {
                dataset_id: args.dataset_id,
                query: args.query,
                insight: args.insight,
                chart_type: args.chart_type,
                region: args.region,
                time: args.time,
            });
            return { content: [{ type: 'text', text: ser(data, args.format) }] };
        }
        if (name === 'create_chart_from_spec') {
            if (!args.dataset_ids?.length) throw new Error('dataset_ids required');
            if (!args.builder_spec || typeof args.builder_spec !== 'object') throw new Error('builder_spec required (object). Call chart_instructions() for the schema.');
            const data = await callChartWriteAPI('POST', '/chart/publish', {
                title: args.title || args.builder_spec.title,
                builder_spec: args.builder_spec,
                insight: args.insight,
                narration: args.narration,
                dataset_ids: args.dataset_ids,
            });
            return { content: [{ type: 'text', text: ser(data, args.format) }] };
        }
        if (name === 'publish_chart') {
            if (!args.dataset_ids?.length) throw new Error('dataset_ids required');
            const data = await callChartWriteAPI('POST', '/chart/publish', {
                title: args.title, plotly_spec: args.plotly_spec,
                insight: args.insight, narration: args.narration, dataset_ids: args.dataset_ids,
            });
            return { content: [{ type: 'text', text: ser(data, args.format) }] };
        }
        if (name === 'update_chart') {
            const data = await callChartWriteAPI('PATCH', `/chart/${args.chart_id}/mcp-update`, {
                plotly_spec: args.plotly_spec,
                title: args.title || undefined,
                insight: args.insight || undefined,
                narration: args.narration || undefined,
            });
            return { content: [{ type: 'text', text: ser({ ...data, url: `${API_BASE}/chart/${args.chart_id}` }, args.format) }] };
        }
    return undefined;
}

module.exports = { VIZ_TOOLS, handleVizTool };
