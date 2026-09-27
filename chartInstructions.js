// backend/mcp/chartInstructions.js
//
// Self-describing schema reference returned by the MCP `chart_instructions`
// tool. An agent calls this once at session-start; the result is the input
// shape for `create_chart_from_spec`. No need to guess Plotly JSON syntax,
// grep tool descriptions, or experiment with malformed specs.
//
// LOCKED layer (cannot be overridden by spec):
//   - Source attribution ("Data: <publisher>") | auto-injected from dataset_ids
//   - autario.com brand watermark | always present
//   - Insight verification gate | rejects hallucinated numbers
//   - Author byline | bound to the publishing API key / user

const CHART_INSTRUCTIONS = {
    summary: 'Send a structured Builder spec to create_chart_from_spec to publish a chart. Brand attribution (publisher source + autario.com) is always added automatically. Insight numbers must be verifiable against the data; hallucinated numbers return 422 with the available anchor list.',
    workflow: [
        '1. Discover datasets via search_datasets / discover_by_topic.',
        '2. Inspect schema via get_dataset_schema; pull stats via query_dataset (use aggregate=avg(value)&groupby=country, etc. for token-efficient summaries).',
        '3. Build a `builder_spec` object using the schema below.',
        '4. Call create_chart_from_spec({ builder_spec, dataset_ids, insight }).',
        '5. Iterate: if you do not like the result, send a refined builder_spec via update_chart_spec(chart_id, partial_spec) — coming soon.',
    ],

    quality_bar: {
        note: 'A published chart is a public, SEO-indexed page that represents autario. A mediocre chart hurts the brand. The following is what "good" looks like | hold to it.',
        title: [
            'Lead with the so-what | the finding, not the dataset name. "Every major EU economy is below replacement fertility" beats "Fertility rate, EU, 2013-2024".',
            'Put the takeaway in the first ~6 words. Year range in parentheses at the end (e.g. "(2013-2024)") whenever the chart has a time axis.',
            'Include the unit/dimension in parentheses at the end ONLY when get_dataset_info returns a non-empty `unit` field. Copy it verbatim | never infer, guess, or derive a unit from the dataset name, topic, or column names. Example: get_dataset_info.unit = "per 1,000 live births" → title "... (per 1,000 live births)". If get_dataset_info.unit is missing or empty, omit the unit entirely | hallucinated units are forbidden. Year range and unit can both appear when both are known: "... (2013-2024, % of GDP)".',
            'Cap ~80 characters (slightly larger than before to fit year+unit). Use a pipe "|", never an em-dash. The title is the SEO headline | make it specific and search-worthy.',
        ],
        data: [
            'bar / hbar: sort categories by value, largest first. An alphabetically-ordered ranking chart is a bug, not a chart.',
            'Choose a meaningful, comparable group_values set (e.g. major economies, peer countries) | never a random or alphabetical slice.',
            'Match chart_type to intent: line = trend over time, bar/hbar = ranking, pie = composition, scatter = correlation.',
            'Label the y-axis with its unit via axis.y.title.',
            'Snapshot charts (one year / one period): set `filter` on the trace so the Builder rehydrates the same slice. Without it the Builder re-derives over every row and shows averaged-over-time data.',
        ],
        insight: [
            '2-3 sentences, lead with the takeaway.',
            'EVERY number must be verifiable against query_dataset output | hallucinated numbers are rejected with 422.',
            'Cite the most striking specific anchors (records, turning points, ratios), not vague generalities.',
            'See `insight_guide` below for the full insight-writing best-practice (format, what is hard-required vs only recommended, and the cross-dataset grounding that makes an insight strong).',
        ],
        language: [
            'Write titles, subtitles, insights, axis labels and annotations in the user\'s language (German if the user wrote German, English by default).',
            'When writing German, use proper umlauts: ä/ö/ü/ß | NOT ae/oe/ue/ss. "größten" not "groessten", "Höhe" not "Hoehe", "Straße" not "Strasse". autario.com is multilingual on purpose; ASCII transliteration looks broken next to the proper characters used elsewhere on the page.',
            'No em-dashes anywhere | use a pipe "|" or a regular hyphen instead. Consistent across every language.',
        ],
    },

    // ── Insight-writing best practice ────────────────────────────────────
    // Since the request_chart rebuild, the CALLING model writes the insight
    // text (autario no longer runs a server LLM for that path). This block
    // hands the caller autario's house conventions so external + internal
    // authoring converge on the same shape. It mirrors the server's own
    // generateInsight prompt (backend/engine/chartGenerator.js). One rule is
    // hard (numbers must be real); everything else is a recommendation the
    // caller may override.
    insight_guide: {
        tone: 'A RECOMMENDATION, not a command. For best results we recommend the conventions below; you are free to write in your own style and tone. Only one thing is enforced: numeric claims are always verified against the underlying data of THIS chart (see non_negotiable). autario\'s own published content additionally runs a full editorial review gate; your insight is held only to the number-verify gate.',

        non_negotiable: {
            label: 'HARD | enforced by the verify gate (not a style preference)',
            rule: 'EVERY number, date, share, ratio, rank or superlative in the insight must come from THIS chart\'s autario data (the query_dataset / get_dataset_schema output for these dataset_ids). Invented or remembered numbers are rejected: the publish call returns 422 with the list of available anchors. This is the truth threshold, not a stylistic nicety.',
            tips: [
                'When in doubt, cite fewer numbers. One correct number beats a richer sentence with a computed (and therefore unverifiable) one.',
                'Do not derive your own distributions / frequencies ("X% of years above average", "most of the period") or your own rankings; use only values the data already gives you.',
                'For a rate / percent / index series there is no CAGR and no "grew X%"; describe the move in points or via min/max/range instead.',
            ],
        },

        format: {
            label: 'RECOMMENDED 5-slot structure (mirrors autario\'s own generated insights)',
            note: 'Lead with the so-what. The top of the page is what LLMs cite and what Google snippets pull, so put the finding and its anchor number first.',
            slots: [
                '1. LEAD (1 sentence, the finding): the takeaway with its strongest verified number and the time/scope. Not the dataset name | the result. e.g. "Every major EU economy sits below the 2.1 replacement fertility line as of 2024."',
                '2. CONTEXT (1-2 sentences, plain English): what the metric measures and its unit/source, for a smart reader with no finance/stats background. Define jargon in the same breath. Name the source organisation.',
                '3. KEY FIGURES / COMPARISON (1-2 sentences): the leader, the spread between highest and lowest plotted series, the range or the sharpest move | all from the data. Name only entities that are actually on this chart.',
                '4. INTERPRETATION (OPTIONAL, 0-1 sentence): a single hedged, plausible reading if one is obvious; otherwise leave it out. A clean description with no "why" is a complete, preferred insight.',
                '5. SOURCE / CITATION: cite the primary source (primary_source_url from get_dataset_info) so the claim is traceable.',
            ],
        },

        recommended: {
            label: 'RECOMMENDED conventions (override if you have a reason)',
            items: [
                'Interpretation is allowed but should be HEDGED: offer exactly ONE plausible reading, framed as a possibility ("may reflect", "one possible factor is", "tends to coincide with"). A hedge word is recommended on any causal sentence.',
                'One cause, not a list. A stack of speculative drivers ("reflects A, B, and C") reads as a guess; drop it and describe instead.',
                'Stay textbook-plausible. Prefer an established factor (demographic transition, digital adoption) over a speculative or surprising reach. Never name a specific event ("the 2008 crisis", "the pandemic") the data cannot show.',
                'No normative judgement: avoid good / bad / success / failure / should / impressive / disappointing. Describe and interpret, never grade.',
                'No em-dash anywhere (it signals AI text). Do not use " | " as a sentence separator either; write sentences that need no separator, or use a short hyphen.',
                'Hot topics (migration, crime, inequality) are fine when handled factually, neutrally and anchored to the data. Truth-first, no agenda.',
                'Write in the user\'s language (German with proper umlauts if they wrote German, English by default).',
            ],
        },

        cross_dataset_grounding: {
            label: 'RECOMMENDED | the autario moat: ground interpretation in a SECOND verified series',
            why: 'The strongest insight does not guess at causality | it anchors the reading in a correlated second autario dataset and cites it. This is the cross-dataset advantage no single-dataset tool has.',
            how: [
                'To deepen or interpret, pull a correlated second autario series via get_entity_data, compare_entities or correlate (and find_drivers / what_matters to surface candidates).',
                'Frame it as a relationship, not proven causation: "fertility declines here track the rising female labour-force-participation series (autario), though correlation is not causation."',
                'Cite the second series so the link is verifiable. Numbers from that second series are subject to the same hard number rule | they must be real.',
            ],
        },
    },

    chart_types: {
        line:           { required: ['x_col', 'y_col OR y_cols'], optional: ['group_by', 'group_values'], use_when: 'time-series trends, single or multi-series; multi-entity via group_by + group_values' },
        bar:            { required: ['x_col', 'y_col'],           optional: ['group_by', 'group_values'], use_when: 'categorical comparisons (countries, products, sectors)' },
        stacked_bar:    { required: ['x_col', 'y_cols'],          optional: [],                          use_when: 'composition over a categorical axis' },
        hbar:           { required: ['x_col', 'y_col'],           optional: ['group_by', 'group_values'], use_when: 'horizontal bars; long category labels' },
        grouped_bar:    { required: ['x_col', 'y_cols'],          optional: [],                          use_when: 'side-by-side comparison of multiple metrics per category' },
        area:           { required: ['x_col', 'y_col OR y_cols'], optional: ['group_by', 'group_values'], use_when: 'trend with magnitude emphasis' },
        stacked_area:   { required: ['x_col', 'y_cols'],          optional: [],                          use_when: 'composition over time' },
        scatter:        { required: ['x_col', 'y_col'],           optional: ['group_by', 'group_values'], use_when: 'two-variable correlation, no time axis assumed' },
        pie:            { required: ['label_col', 'value_col'],   optional: [],                          use_when: 'proportional breakdown of a single metric across categories' },
        donut:          { required: ['label_col', 'value_col'],   optional: ['facet_by', 'facet_values', 'max_slices', 'pie_hole'], use_when: 'composition with a modern donut look; facet_by builds a small-multiples grid (one donut per facet value, e.g. per year) with shared colors + one legend' },
        heatmap:        { required: ['x_col', 'group_by', 'value_col'], optional: ['group_values', 'heatmap_scale', 'value_label'], use_when: 'matrix view of one metric across two categorical dimensions (e.g. entity rows x year columns); great for many-entities-many-periods where lines would spaghetti' },
        comparison:     { required: ['x_col', 'y_cols (length 2)'], optional: [],                        use_when: 'dual y-axis comparison of two metrics with different units (e.g. GDP vs Population)' },
    },

    builder_spec_schema: {
        // ── Required ─────────────────────────────────────────────────────
        chart_type: {
            type: 'enum',
            values: ['line', 'bar', 'stacked-bar', 'hbar', 'grouped_bar', 'area', 'stacked-area', 'scatter', 'pie', 'donut', 'heatmap', 'comparison'],
            description: 'Chart variant; matches Builder UI picker.',
        },
        x_col: {
            type: 'string',
            description: 'Column name in the dataset to use for the x-axis. Required for all types except pie (which uses label_col).',
        },
        y_col: {
            type: 'string',
            description: 'Single y-axis column. Use this OR y_cols, not both.',
        },
        y_cols: {
            type: 'array<string>',
            description: 'Multiple y-columns. Each becomes its own trace (wide-format charts like CDC NCHS measure tables).',
        },
        // ── Long-format multi-entity ─────────────────────────────────────
        group_by: {
            type: 'string',
            description: 'Optional column to group by. When set, one trace per distinct value (or per group_values entry).',
        },
        group_values: {
            type: 'array<string>',
            description: 'Top-N entity filter (e.g. ["DEU", "USA", "CHN"]). Required when group_by is set; otherwise the chart would have hundreds of traces.',
        },
        // ── Row filter (snapshot slicing) ────────────────────────────────
        filter: {
            type: 'array<object>',
            description: 'Row filters applied before plotting. Each entry: { col, op, val } where op ∈ eq|neq|gt|lt|gte|lte|contains. Use for snapshot charts that fix a year/period (e.g. [{col:"date",op:"eq",val:"2023"}]) so Edit-in-Builder rehydrates the same slice instead of averaging across every year.',
            example: [{ col: 'date', op: 'eq', val: '2023' }],
        },
        // ── Sort ─────────────────────────────────────────────────────────
        sort: {
            type: 'enum',
            values: ['desc', 'asc', 'alpha-asc', 'alpha-desc', 'asis'],
            description: 'Category order for bar/hbar charts. Default "desc" (largest first | the only correct ranking-chart order). "asis" preserves the dataset\'s natural order; alpha-* sort by label.',
        },
        // ── Title + text ─────────────────────────────────────────────────
        title:        { type: 'string',                                                 description: 'Chart title. Auto-wraps to 2 lines max at ~70 chars. MANDATORY format when the dataset has a time axis OR a unit: append parentheses with the year range and/or unit at the end. Year range comes from the chart\'s actual data span (e.g. "(2010-2024)"). Unit comes VERBATIM from get_dataset_info → unit field; if that field is null/empty, omit the unit | NEVER invent or infer a unit. Both can appear together: "Greenhouse Gas Emissions by Country (2010-2024, Mt CO2e)". Use a pipe "|" if you also need a source-label suffix like "| World Bank".' },
        subtitle:     { type: 'string',                                                 description: 'Optional subtitle (rendered top-center under title).' },
        title_align:  { type: 'enum', values: ['left', 'center', 'right'],              description: 'Title alignment. Default left (matches Builder).' },
        title_size:   { type: 'number',                                                 description: 'Title font size in px (10-28). Default 16.' },
        // ── Axis overrides ───────────────────────────────────────────────
        axis: {
            x: {
                title:        { type: 'string',                                         description: 'X-axis title text. Default empty (no axis title).' },
                range:        { type: '[number, number]',                               description: '[min, max]. Empty = auto-scale.' },
                type:         { type: 'enum', values: ['linear', 'log', 'date', 'category'] },
                tickformat:   { type: 'string',                                         description: 'D3 format. Examples: "%Y" year-only, "%b %Y" month-year, "%Y-%m-%d" full date.' },
                tickangle:    { type: 'enum', values: [0, -45, -90, 45],                description: 'Rotate tick labels.' },
            },
            y: {
                title:        { type: 'string',                                         description: 'Y-axis title text.' },
                range:        { type: '[number, number]',                               description: '[min, max]. Empty = auto-scale. Sets autorange:false.' },
                type:         { type: 'enum', values: ['linear', 'log'],                description: 'Use "log" for percent / wide-range data.' },
                tickformat:   { type: 'string', values_suggestion: ['auto', ',.0f', ',.1f', '.1%', '.3s', '$,.0f', '$.3s'], description: 'D3 format. ".1%" auto-converts 0-1 fractions to percent (50% instead of 0.5).' },
            },
        },
        // ── Styling ──────────────────────────────────────────────────────
        color_scheme: {
            type: 'enum',
            values: ['default', 'autario', 'warm', 'cool', 'earth', 'pastel', 'mono'],
            description: 'Pre-built palette. "default" = autario blue/green/amber. Or pass an explicit array via `palette`.',
        },
        palette: {
            type: 'array<string>',
            description: 'Custom palette as hex array (e.g. ["#2563eb", "#10b981"]). Wins over color_scheme.',
        },
        series_colors: {
            type: 'object<string, hex>',
            description: 'Per-trace color override: { "USA": "#2563eb", "CHN": "#ef4444" }.',
        },
        line_width:   { type: 'number',                                                 description: '0.5-6 (px). Default 2. Line / area only.' },
        line_dash:    { type: 'enum', values: ['solid', 'dash', 'dot', 'dashdot'],      description: 'Line style.' },
        marker_size:  { type: 'number',                                                 description: '2-20 (px). Scatter only.' },
        bar_gap:      { type: 'number',                                                 description: '0-0.8. Bar charts only.' },
        pie_hole:     { type: 'number',                                                 description: '0-0.7 = donut hole. 0 = full pie. Pie/donut only (donut defaults to 0.55).' },
        // ── Donut grid (chart_type=donut only) ───────────────────────────
        facet_by: {
            type: 'string',
            description: 'Donut only. Column whose distinct values become a small-multiples grid (one donut per value, max 9, latest kept when more). Example: facet_by="year" = one donut per year. Colors are shared across facets; one legend.',
        },
        facet_values: {
            type: 'array<string>',
            description: 'Donut only. Explicit facet list + order (e.g. ["2000", "2010", "2020"]). Omit to use all distinct values (capped at 9, latest kept).',
        },
        max_slices: {
            type: 'number',
            description: 'Pie/donut. Slices beyond this fold into "Other" (default 8).',
        },
        // ── Heatmap (chart_type=heatmap only) ────────────────────────────
        heatmap_scale: {
            type: 'enum',
            values: ['blues', 'greens', 'reds', 'diverging'],
            description: 'Heatmap colorscale. Default blues (light = low). Use diverging for signed metrics.',
        },
        value_label: {
            type: 'string',
            description: 'Heatmap colorbar title (the unit of the cell values). Defaults to a humanized value_col.',
        },
        pie_label_mode: { type: 'enum', values: ['label', 'value', 'percent', 'label+value', 'label+percent', 'all'], description: 'What to show on slices.' },
        label_position: { type: 'enum', values: ['auto', 'inside', 'outside'],          description: 'Pie / bar label position.' },
        show_grid:    { type: 'boolean',                                                description: 'Default true.' },
        grid_color:   { type: 'hex',                                                    description: 'Default #f3f4f6.' },
        show_legend:  { type: 'boolean',                                                description: 'Default true.' },
        legend_pos:   { type: 'enum', values: ['top', 'bottom', 'left', 'right'],       description: 'Default bottom.' },
        bg_color:     { type: 'hex',                                                    description: 'Plot + paper background. Default white.' },
        font_color:   { type: 'hex',                                                    description: 'Default #374151.' },
        font_family:  { type: 'enum', values: ['Inter', 'Georgia', 'Mono', 'Playfair'], description: 'Default Inter.' },
        chart_height: { type: 'number',                                                 description: '350-900 (px). Default 500.' },
        // ── Annotations + analysis overlays ─────────────────────────────
        annotations: {
            type: 'array<object>',
            description: 'User-authored callouts on the plot. Each: { text, x, y, xref?:"x"|"paper", yref?:"y"|"paper", arrow?:bool, color?, font_size? }. Use to highlight events, peaks, or context.',
            example: [{ text: 'COVID shock', x: '2020-04', y: 18000, arrow: true, color: '#ef4444' }],
        },
        event_bands: {
            type: 'array<object>',
            description: 'Shaded x-axis ranges to mark periods (recessions, wars, policy windows). Each: { label, start, end, color? }.',
            example: [{ label: 'COVID', start: '2020-03', end: '2020-12', color: '#fbbf24' }],
        },
        overlays: {
            type: 'array<object>',
            description: 'Reference lines + analytical markers. Each: { type:"hline"|"vline"|"cagr"|"diff", value?, label?, color?, dash? }.',
            example: [{ type: 'hline', value: 100, label: 'Threshold', color: '#ef4444', dash: 'dash' }],
        },
    },

    locked_fields: {
        // The following are NEVER overrideable via builder_spec | applied
        // last by enrichBuilderLayout for consistency across ALL published
        // charts. Niko's "single canonical layout" requirement.
        source_attribution: 'Auto-rendered as "Data: <publisher>" bottom-left. Pulled from dataset_ids.',
        autario_brand:      'autario.com watermark always present top-right.',
        author_byline:      'Bound to publishing API-key user. Cannot be set by spec.',
        insight_gate:       'verify_insight blocks hallucinated numbers; emergency override only via env.',
    },

    examples: [
        {
            goal: 'Compare top-5 countries on a metric over time (multi-entity line chart)',
            dataset_ids: ['<world-bank-gdp-uuid>'],
            builder_spec: {
                chart_type: 'line',
                x_col: 'date',
                y_col: 'value',
                group_by: 'country',
                group_values: ['DEU', 'USA', 'CHN', 'IND', 'JPN'],
                title: 'GDP | Major Economies (2000-2024)',
                color_scheme: 'default',
                axis: { y: { title: 'USD billions', tickformat: '$.3s' } },
            },
            insight: 'USA led at 27 trillion USD in 2024, with China at 18 trillion and Germany at 4.5 trillion. The 2008 crisis dipped all five before resuming growth.',
        },
        {
            goal: 'Wide-format multi-measure (CDC NCHS deaths by cause)',
            dataset_ids: ['<cdc-nchs-uuid>'],
            builder_spec: {
                chart_type: 'line',
                x_col: 'year',
                y_cols: ['malignant_neoplasms', 'diseases_of_heart', 'covid_19_underlying_cause', 'alzheimer_disease', 'accidents_unintentional'],
                title: 'US Deaths by Major Cause (2020-2024)',
                color_scheme: 'warm',
            },
            insight: '...',
        },
        {
            goal: 'Bar chart with percentage y-axis and event band',
            dataset_ids: ['<unemployment-uuid>'],
            builder_spec: {
                chart_type: 'line',
                x_col: 'date',
                y_col: 'rate',
                title: 'US Unemployment Rate',
                axis: { y: { tickformat: '.1%' } },
                event_bands: [{ label: 'COVID', start: '2020-03', end: '2020-12', color: '#fbbf24' }],
                overlays:    [{ type: 'hline', value: 0.05, label: 'Natural rate', dash: 'dash' }],
            },
            insight: 'Unemployment spiked from 3.5% in February 2020 to a peak of 14.8% in April 2020 before recovering to 3.6% by 2022.',
        },
        {
            goal: 'Pie chart of energy mix',
            dataset_ids: ['<energy-mix-uuid>'],
            builder_spec: {
                chart_type: 'pie',
                label_col: 'fuel',
                value_col: 'share',
                title: 'Global Energy Mix 2024',
                pie_label_mode: 'label+percent',
                pie_hole: 0.4,
                color_scheme: 'earth',
            },
            insight: '...',
        },
        {
            goal: 'Donut small-multiples: energy mix per decade (one donut per year)',
            dataset_ids: ['<energy-mix-uuid>'],
            builder_spec: {
                chart_type: 'donut',
                label_col: 'fuel',
                value_col: 'share',
                facet_by: 'year',
                facet_values: ['2000', '2010', '2020'],
                title: 'Global Energy Mix by Decade (2000-2020)',
            },
            insight: '...',
        },
        {
            goal: 'Heatmap: inflation across major economies by year',
            dataset_ids: ['<inflation-uuid>'],
            builder_spec: {
                chart_type: 'heatmap',
                x_col: 'date',
                group_by: 'country',
                group_values: ['DEU', 'USA', 'CHN', 'JPN', 'GBR', 'FRA'],
                value_col: 'value',
                heatmap_scale: 'reds',
                value_label: '% per year',
                title: 'Inflation Heatmap | Major Economies (2000-2024)',
            },
            insight: '...',
        },
    ],
};

module.exports = { CHART_INSTRUCTIONS };
