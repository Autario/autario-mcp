// backend/mcp/tools-apps.js
// OWNED BY Track B (Distribution)
// App tools | expose autario DATA-APPS (not raw data, not viz) to LLM clients.
// Each app tool is a thin wrapper over the app's PUBLIC REST API (dogfooding |
// the same door a 3rd-party dev uses), returning a verifiable result + the live
// interactive chart link + an embeddable iframe (the surface a ChatGPT Apps-SDK /
// MCP-UI widget renders inline in the chat). Definitions (APP_TOOLS) + handler
// (handleAppTool). Union assembled in tools.js. First app: bubble_or_not.

const { API_BASE, fetch, als, ser, authHeaders, callWriteAPI, FORMAT_PROP } = require('./tools-common');

// WHICH CONNECTIONS a report reads, inside the brand (spec 2026-09-22-brand-
// vocabulary-and-instance-scope). Declared ONCE and spread into every own-data
// tool that takes a scope, so an agent learns one word and the five reports
// cannot disagree about it. Omitted means every connection of the scope, which
// is exactly what these tools have always answered.
const INSTANCES_PROP = {
    instances: {
        type: 'string',
        description: 'Optional comma-separated connector instance ids, to narrow the report to some of the connections inside the selected brand (for example one of two Search Console properties). Omitted means all of them. An id that is not yours, or not in that brand, answers an error rather than a quietly shorter report. The ids are the instance ids get_app_context returns for this app.',
    },
};

// The ONE place a scope argument becomes a query parameter. Two words, read
// the same way by every tool below.
function setScope(qs, args) {
    if (args && args.brand) qs.set('brand', String(args.brand));
    if (args && args.instances) qs.set('instances', String(args.instances));
    return qs;
}

const APP_TOOLS = [
    {
        name: 'get_traction_overview',
        description: 'ADMIN/CURATOR ONLY, autario\'s own traction. ONE report uniting the three real signal sources: real human reach (GA4-humans), the MCP/agent channel (mcp_tool_call volume + success-rate + top tools), the signup funnel (new signups, source/medium/trigger) and the activation half of it (charts created, charts published, publish failures, logins), plus the biggest drop-off in plain language, MCP-calls-per-dataset (what agents pull), top charts by views, top API endpoints (human-only), and per-app usage (web views vs MCP calls, Bubble Or Not explicit). Every page-view/funnel number is HUMAN-ONLY | own-pipeline renders (screenshot worker / chart-gen) and generic bots are classified out (`bot_or_own`, an excluded-count) and never inflate the headline. A separate `llm_crawler` section (total + by-crawler family + top pages) answers "do LLMs fetch the page content when they cite us?". 30-day window. Returns ONE JSON snapshot (cached, fast). Requires the connector to be OAuth-authorized as the autario curator account | any other caller gets a permission error. Use when asked "how is autario doing", "show traction", "what is the funnel", "which datasets do agents use", "how many signups", "do LLMs crawl us".',
        annotations: { title: 'Traction Overview (admin)', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'get_engine_report',
        description: 'ADMIN/CURATOR ONLY, autario\'s own ingest engine. The machine-readable health of the pipeline that pulls World Bank, FRED, Eurostat, OECD, WHO, IMF, ECB, US Census and SEC into the catalog, in ONE snapshot: the ingestion funnel (sources registered to user-visible datasets, with every drop-off labelled by reason | policy-excluded, quarantined, errored, empty), the dirty backlog, shadow-column coverage WITH the concrete asset list still needing backfill, per-provider health, the top failure patterns, job queue state and active alerts. This is the same report /admin/health and /admin/storage render, but as data you can reason over instead of screenshots. Read-only and never auto-fixes | it tells you what is broken and which assets are affected; a human or an engine change does the fix. Set `trends: true` to add the day-bucketed run/event history, which answers "did my change help?" (the before/after gauge). Requires the connector to be OAuth-authorized as the autario curator account | any other caller gets a permission error. Use when asked "how is the engine doing", "what is broken", "why are there so many source errors", "what is the ingest funnel", "which assets need backfill", "did the last fix work".',
        annotations: { title: 'Engine Health Report (admin)', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                trends: { type: 'boolean', description: 'Also return the day-bucketed engine run/event history (default false). Use it to compare before and after an engine change.' },
                trend_days: { type: 'integer', description: 'How many days of history when trends=true (default 30, max 90).' },
                ...FORMAT_PROP,
            },
            additionalProperties: false,
        },
    },
    {
        name: 'list_apps',
        description: 'List the autario data apps (the app catalog): id, name, what each app does, its live page URL, and data_scope (private = the app works on the caller\'s own connected data from Google Search Console, GA4, Meta Ads, Google Ads, YouTube, TikTok, Instagram, Facebook, Shopify or LinkedIn; public = it runs on public autario datasets only). Includes AI Visibility 360 (which brands ChatGPT, Claude, Gemini and Perplexity recommend), SEO 360, Social 360, Audience 360 and Bubble Or Not. When the caller is authenticated (API key or OAuth) each app also carries connected=true/false, whether YOUR data is already behind it (a connector instance the app consumes, or artifacts you saved in it). Start here when a user mentions an app by name ("my Audience 360", "my projects") or asks what apps exist, then call get_app_context(app_id) for the data map of one app. Read-only, no cost.',
        annotations: { title: 'List Data Apps', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: { type: 'object', properties: { ...FORMAT_PROP }, additionalProperties: false },
    },
    {
        name: 'get_app_context',
        description: 'The data map behind ONE autario app, so you can query app-first instead of guessing across thousands of datasets. Returns the app manifest (what it consumes, which connector providers it reads | Google Search Console, GA4, Google Ads, Meta Ads, YouTube, TikTok, Instagram, Facebook, Shopify, LinkedIn, Bing) and, for an authenticated caller, YOUR OWN reality behind it: your connector-instance tables (per-operation table with column list, row count, backing dataset_id and last refresh), your saved artifacts in the app, and 2-3 ready-to-run query examples on existing endpoints (query the dataset_id with query_dataset or GET /datasets/:id/data). Secrets and credentials are never included. Unauthenticated callers get the public manifest view. Use when a user asks "what does my <app> run on", "what data is behind <app>", "query my Search Console data" (Audience 360), or before analyzing any app-connected data. app ids come from list_apps.',
        annotations: { title: 'App Data Context', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                app_id: { type: 'string', description: 'App id from list_apps, e.g. "audience-360", "company-compare", "projects", "builder".' },
                ...FORMAT_PROP,
            },
            required: ['app_id'],
        },
    },
    {
        name: 'get_my_workspace',
        description: 'YOUR data-app workspace in ONE call: every autario app the calling user has activated or connected, each with its platforms (Google Search Console, GA4, Google Ads, Meta Ads, YouTube, TikTok, Instagram, Facebook, Shopify, LinkedIn, Bing), connector-backed tables (dataset_id/slug + row count + last refresh), saved artifact list and a ready-to-run query example. THE first call when a user references "my <app>", "my dashboard", "my report" or asks what they have on autario | it replaces one get_app_context round-trip per app and guarantees you reason over the SAME datasets and saved views the user sees (no dataset guessing, no hallucinated numbers). Drill down with get_app_artifact(app_id, slug) for an exact saved view or query_dataset(dataset_id) for rows. Requires authentication (API key or OAuth). Read-only, no cost.',
        annotations: { title: 'My App Workspace', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, autarioAuthRequired: true },
        inputSchema: { type: 'object', properties: { ...FORMAT_PROP }, additionalProperties: false },
    },
    {
        name: 'get_app_artifact',
        description: 'Load ONE saved artifact from an autario data app | the EXACT view state the user saved there (a saved SEO 360 / Audience 360 / Social 360 / AI Visibility 360 report configuration, a Plotly chart spec, a screener view) plus any inline data, so your answer is grounded in what the user actually sees instead of a guess. Call after get_app_context / get_my_workspace listed the artifact slugs. Owner-gated: you see your own artifacts plus public/unlisted ones; foreign private artifacts are invisible. Very large specs/data are truncated honestly (marked with truncation notes; row/item counts stay correct) | for full raw data query the app\'s datasets via query_dataset. Read-only, no cost.',
        annotations: { title: 'App Artifact (saved view)', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                app_id: { type: 'string', description: 'App id from list_apps, e.g. "audience-360", "projects", "builder".' },
                slug: { type: 'string', description: 'Artifact slug from get_app_context / get_my_workspace (your_artifacts[].slug).' },
                ...FORMAT_PROP,
            },
            required: ['app_id', 'slug'],
        },
    },
    {
        name: 'audience_360',
        description: 'Audience 360 | the caller\'s OWN audience report over their connected Google Search Console + GA4 + social (Facebook Page, Instagram, TikTok) connector data, computed deterministically server-side (the exact numbers the user sees in the app | nothing re-derived, nothing estimated). Use this FIRST for any interpretation question about a user\'s traffic/audience ("why is my AI traffic falling", "which queries are rising", "which pages do AI assistants cite", "how is my funnel doing") | it is far more token-efficient and more faithful than rebuilding KPIs from raw connector tables. Pick only the sections you need: overview (funnel stages + audience segments), channels (weekly channel mix + AI-share shift + brand-vs-generic clicks), queries (top brand/generic queries + 28d risers/fallers + high-impression-low-click opportunities), content (per-page sessions x engagement joined with search demand + AI-cited pages), audience (countries, devices, new-vs-returning, totals), conversions (GA4 key events), social (connected Facebook Page / Instagram / TikTok reach, follower trends, top posts, post-format engagement + IG follower demographics), health (report-vs-API cross-checks). Lists are capped and weekly series bounded; every truncation is marked with an omitted count. Filter with range/channel/countries to sharpen the question. Requires the caller\'s own autario account (API key or OAuth) with the Audience 360 app connected | see get_app_context("audience-360") for the data map behind it.',
        // Own-data tool: must trigger the OAuth challenge on the remote server,
        // never fall through to the server identity (authz-matrix 2026-07-20).
        annotations: { title: 'Audience 360 Report', readOnlyHint: true, autarioAuthRequired: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                sections: {
                    type: 'array',
                    items: { type: 'string', enum: ['overview', 'channels', 'queries', 'content', 'audience', 'conversions', 'social', 'health'] },
                    description: 'Which report sections to return. Default ["overview","channels"]. Request only what the question needs (token efficiency); call again for more.',
                },
                range: { type: 'string', enum: ['1w', '2w', '30d', '90d', 'ttm', 'ytd', 'py', 'custom'], description: 'Time window preset. Relative presets anchor at the newest data day. Default 90d. Use "custom" together with from/to.' },
                from: { type: 'string', description: 'Custom window start (YYYY-MM-DD), only with range=custom.' },
                to:   { type: 'string', description: 'Custom window end (YYYY-MM-DD), only with range=custom.' },
                channel: { type: 'string', enum: ['ai', 'bing', 'google', 'social', 'direct', 'referral'], description: 'Optional single-channel filter (sections that cannot honor it say so in notes).' },
                countries: { type: 'string', description: 'Optional comma-separated ISO country codes filter, e.g. "DEU,USA".' },
                brand_term: { type: 'string', description: 'Optional brand TERM override for the brand-vs-generic query split (default: derived from the GSC property). Renamed from `brand` on 2026-09-22, when that word became the connector grouping everywhere; a non-uuid `brand` is still read as this.' },
                brand: { type: 'string', description: 'The brand (connector grouping) id to report on, as a uuid. A non-uuid value is read as `brand_term` instead, so a caller written before 2026-09-22 keeps working.' },
                ...INSTANCES_PROP,
                ...FORMAT_PROP,
            },
            additionalProperties: false,
        },
    },
    {
        name: 'seo_360',
        description: 'SEO 360 | the caller\'s OWN deterministic Google Search Console ACTION report, computed server-side from their connected GSC data (the exact numbers the user sees in the app | nothing re-derived, nothing estimated). The unit is the (query, page) pair and EVERY row ends in a concrete action, so this is the tool to call when a user asks "what should I write next", "which page should I fix first", "where am I losing clicks", "how are my rankings developing", "which pages are decaying", "how are my Core Web Vitals", "what technical SEO issues does my site have". Sections: page2_gaps (position 8-20 pairs ranked by potential click gain toward the top 3 | the core write-or-improve list), ctr_underperformers (ranks top-10 but the snippet loses the click | title/description work), orphan_demand (queries with demand whose best page is not about them | the page is missing, write it), cannibalization (one query split across pages | consolidate or differentiate), trends (click winners/losers AND position winners/losers vs the previous window, honestly flagged when the previous window is incomplete), rank_tracking (position series of the top + pinned queries with current vs 7d/28d deltas, ranking distribution Top3/4-10/11-20/21+, share-of-voice index, brand vs generic split), decay (the refresh queue: pages losing clicks across consecutive windows, ranked by lost clicks, with an optional EUR translation from the user\'s own click-value setting), vitals (Core Web Vitals p75 field data from the Chrome UX Report for the top pages, pass/fail per LCP/INP/CLS), audit (bounded own-site crawl snapshot: broken links, redirect chains, title/description issues, noindex/canonical conflicts, orphan pages, new-vs-fixed diff, internal-link opportunities), health (data coverage, staleness, which CTR-benchmark source applies). The CTR benchmark is the median of the caller\'s OWN data per position bucket, with a documented default curve as fallback per thin bucket. Deeper than audience_360 (which answers "who comes from where"): this one prescribes the next SEO action. Requires the caller\'s own autario account (API key or OAuth) with a Search Console connection | see get_app_context("seo-360").',
        // Own-data tool: must trigger the OAuth challenge on the remote server,
        // never fall through to the server identity (authz-matrix pattern).
        annotations: { title: 'SEO 360 Action Report', readOnlyHint: true, autarioAuthRequired: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                sections: {
                    type: 'array',
                    items: { type: 'string', enum: ['page2_gaps', 'ctr_underperformers', 'orphan_demand', 'cannibalization', 'trends', 'rank_tracking', 'decay', 'vitals', 'audit', 'health'] },
                    description: 'Which report sections to return. Default ["page2_gaps","health"]. Request only what the question needs (token efficiency); call again for more.',
                },
                days: { type: 'integer', description: 'Analysis window in days (7-90, default 28), anchored at the newest day of the caller\'s data. The trend comparison uses the same-length window before it.' },
                ...FORMAT_PROP,
            },
            additionalProperties: false,
        },
    },
    {
        name: 'social_360',
        description: 'Social 360 | the caller\'s OWN deterministic social performance report over their connected Facebook Page, Instagram, TikTok, YouTube and LinkedIn (own profile and page) data, computed server-side (the exact numbers the user sees in the app | nothing re-derived, nothing estimated). Call it when a user asks "how are my social accounts doing", "is my account growing", "which post worked best", "which format should I post more of", "when should I post", "what caused the follower jump", "how do I compare to my competitors". Sections: score (a 0-100 index per platform plus a reach-weighted blended total from engagement rate on reach, follower growth rate and posting consistency, with a trend | an index against the account\'s OWN history, never an industry benchmark; a component the platform cannot report is DROPPED and the weights renormalized, never counted as zero), explorer (EVERY connected channel as its own daily series for every KPI the platform officially reports | followers, new followers, posts, engagements, likes, comments, shares, views, reach | plus a per-KPI support matrix naming WHY a platform cannot answer a KPI, so a missing number is never read as a zero), posts (cross-platform top posts sortable by engagement/reach/views/likes/comments/shares/saves, the per-format benchmark inside the own account with low-sample flags, posting frequency vs engagement per week, and per-post effectiveness against the median post of the same format on the same channel), geo (the country breakdowns the platforms OFFICIALLY publish: Instagram audience demographics and the YouTube geography report; Facebook and TikTok publish none and say so), spikes (statistically unusual follower or reach days with the posts published in that window listed as CANDIDATES | hedged by design, never a claimed cause), peers (You vs the public accounts the user tracks under Settings > Competitors, via the shared daily benchmark store on Instagram Business Discovery and the YouTube Data API: follower gap, growth race, posting frequency, public post engagement; a YouTube peer carries follower/view/video counts only, with the reason), findings (the deterministic works / needs-attention list: format leaders and decays, channel momentum, reach declines at stable posting, unanswered spikes | each with a hedged reading and an evidence line citing the numbers), financials (paid performance from the connected ads accounts | Meta Ads, Google Ads, TikTok Ads: spend, impressions, clicks, CPC and CPM per account and per campaign with the currency on every figure, revenue and ROAS ONLY where the ad platform itself reports a money value, plus an honest paid vs organic side-by-side that never sums the two), health (what each platform counts as reach, connector freshness, days and posts in the window, and the caveats that explain an empty section). Reads EVERY connected channel per platform (a user with four Instagram accounts gets four), and a platform figure is the fold of its channels. Works with ONE connected channel; every unconnected platform carries an honest not-connected state instead of zeros. Deeper than audience_360 (which answers "who comes from where" and keeps a high-level social reach section): this one judges social performance and names the post behind it. Requires the caller\'s own autario account (API key or OAuth) with at least one social connector | see get_app_context("social-360").',
        // Own-data tool: must trigger the OAuth challenge on the remote server,
        // never fall through to the server identity (authz-matrix pattern).
        annotations: { title: 'Social 360 Report', readOnlyHint: true, autarioAuthRequired: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                sections: {
                    type: 'array',
                    items: { type: 'string', enum: ['score', 'explorer', 'posts', 'activity', 'geo', 'spikes', 'peers', 'financials', 'findings', 'health'] },
                    description: 'Which report sections to return. Default ["score","health"]. Request only what the question needs (token efficiency); call again for more. activity = the activity table: every post with platform, content type, topic, post type, sentiment and language, per-dimension pivots and the (platform, content type, topic, language) groups that beat the platform median; labels come from the user\'s own classification run.',
                },
                days: { type: 'integer', description: 'Analysis window in days (7-90, default 28). Each platform anchors it at the newest day of ITS OWN connector table, because connectors refresh on different rhythms.' },
                sort: { type: 'string', enum: ['engagement', 'reach', 'views', 'likes', 'comments', 'shares', 'saves'], description: 'How the cross-platform top-post list is ranked (posts section). Default engagement.' },
                ...INSTANCES_PROP,
                ...FORMAT_PROP,
            },
            additionalProperties: false,
        },
    },
    {
        name: 'marketing_report',
        description: 'Marketing Report | the caller\'s OWN brand marketing report, read deterministically from the derived `marketing_daily` table server-side (the exact numbers the user sees in the app | nothing re-derived, nothing estimated, no LLM). In one sentence: what one brand spent across Meta Ads, Google Ads, TikTok Ads, Shopify, Amazon and Google Analytics, and what came back, under ONE definition of return on ad spend. Call it when a user asks "how did brand X do last week", "what did we spend on Meta vs Google", "which campaign has the best ROAS", "what is our cost per acquisition this month", "did spend go up compared to last week", "is any channel stale". Sections: overview (spend, conversions, revenue, conversion value, return on ad spend and cost per acquisition for the period, each with the same figure for the comparison period and the move between them, plus one real total PER CURRENCY and the printed definition of every ratio), channels (one row per channel | meta_ads, google_ads, tiktok_ads, shopify, amazon, ga4 | with the same columns, its share of the spend and its own move), campaigns (top campaigns by spend and by return on ad spend, each carrying the spend behind the ratio so a tiny campaign with a spectacular number is visibly tiny), daily (one row per day that actually reported, with spend and return on ad spend). THE HONESTY RULES, which are part of the data and not a disclaimer: money is NEVER converted between currencies, so a total over more than one currency is null with a `reason` naming them and the per-currency breakdown is the answer instead; conversions and conversion value are what each ad platform reported under its OWN attribution setting and are never de-duplicated across channels; shop revenue and analytics revenue are separate rows and must never be added; a day no platform reported is ABSENT from the daily series rather than present as a zero; a ratio with no denominator is null, never infinite and never zero. The comparison period is the same window shifted by its own rhythm (a week for the week presets, so Monday compares to Monday). Scope: one brand per call | pass `brand` to pick one (the older spelling `client` is still accepted), otherwise the account\'s Default brand answers. A brand that is not the caller\'s answers an error, never another brand\'s numbers. An account with nothing connected gets a named empty state saying which of the four reasons applies, never a zero. Requires the caller\'s own autario account (API key or OAuth) with at least one ad or shop connector | see get_app_context("marketing-report").',
        // Own-data tool: must trigger the OAuth challenge on the remote server,
        // never fall through to the server identity (authz-matrix pattern).
        annotations: { title: 'Brand Marketing Report', readOnlyHint: true, autarioAuthRequired: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                sections: {
                    type: 'array',
                    items: { type: 'string', enum: ['overview', 'channels', 'campaigns', 'daily'] },
                    description: 'Which report sections to return. Default ["overview"]. Request only what the question needs (token efficiency); call again for more.',
                },
                brand: { type: 'string', description: 'The brand id (uuid) to report on. Omitted means the account\'s Default brand, which is where every unassigned connector already belongs. Every response lists the caller\'s brands, so a first call without this argument tells you what to pass next.' },
                client: { type: 'string', description: 'Deprecated spelling of `brand`, still accepted so callers written before 2026-09-22 keep working. Pass `brand`.' },
                period: { type: 'string', enum: ['this-week', 'last-week', 'last-30', 'custom'], description: 'The reporting window. Default last-30. "this-week" runs Monday to today and compares to the same weekdays one week earlier; "custom" needs `from` and `to`.' },
                from: { type: 'string', description: 'Start day (YYYY-MM-DD) when period is "custom". An unusable pair falls back to the default window rather than erroring.' },
                to: { type: 'string', description: 'End day (YYYY-MM-DD) when period is "custom".' },
                ...INSTANCES_PROP,
                ...FORMAT_PROP,
            },
            additionalProperties: false,
        },
    },
    {
        name: 'ai_visibility_360',
        description: 'AI Visibility 360 | the caller\'s OWN brand-visibility report across the AI assistants (ChatGPT, Claude, Gemini, Perplexity, optionally Grok/DeepSeek/Mistral), read deterministically from stored runs server-side (the exact numbers the user sees in the app | nothing re-derived, NO LLM runs on this read and no run is started). In one sentence: which brands ChatGPT, Claude, Gemini and Perplexity recommend when someone asks about your category. Call it when a user asks "how visible is my brand in ChatGPT", "do assistants recommend us or a competitor", "which sources do the assistants cite", "what should we do to show up more", "did the AI visibility work turn into real traffic". Sections: overview (visibility score with delta and rank, the brand-vs-competitor leaderboard with visibility / share of voice / sentiment / average position, the per-provider score matrix and the concrete models that answered), prompts (per-prompt brand score vs the strongest competitor plus per-question-category rollups), sources (citation share of the brand\'s own domains, the cited-domain leaderboard, which providers expose citations at all), actions (the deterministic to-do queue: earned = pages to get featured on, owned = pages to build, each with impact and status), answers (the newest stored assistant answers with detected brand mentions and cited domains, text truncated honestly), impact (GA4 sessions referred by AI assistants for the property explicitly linked to this brand; an unlinked brand gets the honest empty state and the reason, never another property\'s numbers). EVERY number here counts only questions that do NOT name your own brand: a question naming the brand has already handed the assistant the answer. That holds for visibility, share of voice, rank and the per-assistant matrix AND for sources, gaps, pages, assistant searches, domain movers, perception and action effects. The questions that do name it are still measured, in `rankings_branded`, and the `population` block (present on every section set) carries both counts | never add the two together. The two evidence views keep every row instead: the prompt table (flag `names_you`) and `answers` (flag `question_names_your_brand`). A metric the window cannot support is null or absent (an honest dash), never a zero. Reads ONLY brands owned by the calling account; runs, prompt edits and settings are deliberately not exposed here. Recipe: pull the sections you need and interpret them yourself, citing the numbers. For a custom deliverable, write your derived table with create_dataset + write_rows and chart it with create_chart_from_spec. Requires the caller\'s own autario account (API key or OAuth) with an AI Visibility brand set up | see get_app_context("ai-visibility").',
        // Own-data tool: must trigger the OAuth challenge on the remote server,
        // never fall through to the server identity (authz-matrix pattern).
        annotations: { title: 'AI Visibility 360 Report', readOnlyHint: true, autarioAuthRequired: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                brand: { type: 'string', description: 'Brand name or brand id. Optional when the account has exactly one brand; with several brands the tool answers with the list so you can re-call with one (nothing is picked for you).' },
                sections: {
                    type: 'array',
                    items: { type: 'string', enum: ['overview', 'prompts', 'sources', 'actions', 'answers', 'impact', 'searches', 'movers', 'pages', 'crawlability', 'perception', 'action_effects', 'gaps', 'model_rankings'] },
                    description: 'Which report sections to return. Default ["overview"]. Request only what the question needs (token efficiency); call again for more. searches = the web searches the assistants ran behind their answers (grouped by topic, brands named in them); movers = cited domains that are new / trending / losing against the prior window; pages = the cited pages with what is ON them (title, page type, which tracked brands the page names); crawlability = what each domain\'s robots.txt says to each AI crawler (GPTBot, ClaudeBot, PerplexityBot...) plus llms.txt; perception = the descriptor words the answers use next to each brand, as a brand-by-word matrix; action_effects = the brand\'s visibility 14 days before and after every action marked done; gaps = the sources that cite a competitor and never this brand, with gap score, used-as-a-source share, prompt coverage and competitor rate (each defined on the page; there is deliberately no retrieval rate, because only citations are observable); model_rankings = the brands each assistant names most, as a rank order with the owned brand flagged.',
                },
                days: { type: 'integer', description: 'Analysis window in days over the stored runs (1-365, default 30).' },
                ...FORMAT_PROP,
            },
            additionalProperties: false,
        },
    },
    {
        name: 'bubble_or_not',
        description: 'Bubble Or Not? | Check whether a public US stock\'s price is running ahead of (or backed by) its fundamentals. Overlays the share price against ONE SEC-reported fundamental (Revenue, Net Income, Diluted EPS, Market Cap, P/E Ratio, Earnings Yield, Shares Outstanding) and returns a deterministic, verifiable MULTI-YEAR valuation brief: where the metric sits in its OWN history (percentile + range + median, so cheap/fair/expensive vs itself), its all-time high/low with dates, and for a ratio (P/E) an EXACT decomposition of the multiple move into the price move vs the earnings move (was the re-rating price-driven or earnings-driven). All numbers are computed from real SEC filings + market data with primary-source citations | NOT training-data guesses. Unknown tickers are fetched live (Yahoo price + SEC filings). Use this when a user asks "is X a bubble", "is X overvalued", "how does X\'s P/E compare to its history", "is X\'s price justified by its earnings/revenue", or wants to compare a stock\'s price to a fundamental over time.\n\nReturns the multi-year verdict + numbers AS TEXT (plus a compact `valuation` block: percentile, range, decomposition), an INLINE CHART IMAGE of the exact overlay, and a shareable view_url that reproduces that same view. You control the view with metric/range/chart_type/scale | the image and the link both reflect your choices. When recommending the graphical view, link autario.com/apps/bubble-or-not/<ticker>.\n\nExamples:\n- "Is NVDA a bubble?" | ticker=NVDA\n- "Apple price vs revenue, last 5 years, bars" | ticker=AAPL, metric=Revenue, range=5Y, chart_type=bar\n- "Is UNH overvalued? how does its P/E track history" | ticker=UNH, metric=P/E Ratio\n- "TSLA price vs P/E, indexed" | ticker=TSLA, metric=P/E Ratio, scale=indexed',
        // openWorldHint: the one READ tool that reaches outside autario | an unknown ticker is
        // fetched live from Yahoo (price) and SEC EDGAR (filings) before the brief is built.
        annotations: { title: 'Bubble Or Not?', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        inputSchema: {
            type: 'object',
            properties: {
                ticker:     { type: 'string', description: 'US stock ticker symbol, e.g. AAPL, MSFT, NVDA, TSLA, AMZN' },
                metric:     { type: 'string', description: 'Optional fundamental to overlay against price. One of the labels from the company\'s available metrics (e.g. "Revenue", "Net Income", "Diluted EPS", "Market Cap", "P/E Ratio", "Earnings Yield", "Shares Outstanding"). If omitted, a sensible default is chosen. The response lists available_metrics so you can re-call with another.' },
                range:      { type: 'string', enum: ['YTD', '1Y', '2Y', '5Y', '10Y', 'ALL'], description: 'Optional time window for the chart. Default ALL (full history).' },
                chart_type: { type: 'string', enum: ['line', 'bar'], description: 'Optional render style for the fundamental: line or bar. Default is the app\'s smart choice (bars for quarterly reports, line for daily-derived metrics).' },
                scale:      { type: 'string', enum: ['absolute', 'indexed'], description: 'Optional value scale. "absolute" = raw values on a dual axis. "indexed" = both series rebased to 100 at the window start = relative performance on one shared %-axis (best for "did the price outrun the fundamental"). Default absolute.' },
            },
            required: ['ticker'],
        },
    },
    {
        name: 'projects',
        description: 'Projects | the caller\'s OWN project board with its objectives and key results, read and written deterministically (no LLM on this path): what a team agreed to achieve, what it works on, who works on it, how far along it is, and which key result each piece of work pays into. Call it for "what is my team working on", "which key result has no project behind it", "what does marketing contribute", "which projects are off track", "what is undecided", or to add or move a project, objective or key result.\n\nPROJECTS: "list" folds the board on ONE axis, `group` = okr (default) | country | function | person. On person a project appears under its owner and every contributor; on the other axes once. Nothing set on the axis lands in a NAMED group ("No country set"), never dropped. Undecided projects come back in `inbox`. "get" returns one project with milestones and KPIs; "create" adds one; "update" changes one (stage, progress, traffic light, dates, parent, budget, effort, impact, key_result_id). A project carries a target date (due sentence derived on read), a parent (three levels at most), prerequisites (`blocked_by`), a budget in its own currency (never converted), effort in days and impact 1 to 5; `sort` = effort_impact orders by impact then effort without a score.\n\nOBJECTIVES: "objectives" returns every objective with its key results: value, `source` (dataset or manual), a DERIVED status (on track, at risk, off track, no data yet; from baseline, target, direction and time left, never set by hand, and no value is never on track), guardrails, target history and the projects behind it. "create_objective" needs `title`; "update_objective" needs `id`; "create_key_result" needs `objective_id`, `title`, `target` (or `country_values`); "update_key_result" needs `id`. Changing a target needs `target_reason` (ten characters or more) and is kept in a history nothing rewrites. A key result may carry values per country (`country_values`) and says how they add up (`aggregation`); with country values its target and current are DERIVED from them (sum, average, or none = no total, `country_total` says how many countries reported) and a typed target is ignored, and with `country_column` a dataset-bound key result reads `value_column` once per country. A key result with `guards_id` is a GUARDRAIL: breached, the guarded key result is off track even at full attainment.\n\nTHE VALUE RULE for KPIs and key results: EITHER a typed number OR read live from a column of any dataset on this account, such as a Google Search Console, Shopify or World Bank table or an uploaded CSV (dataset_id + value_column, optionally filter_column + filter_value), never both. A value that cannot be read is null with a `reason`, never zero.\n\nNEVER: it never derives the traffic light or progress of a project (a person sets both), never invents a key result (link one of the account key results by `key_result_id`; `list` returns them as `key_results`), and never reaches another account: a foreign id answers not found. On a shared board a member with the editor role is a project lead: the board admin decides which fields a lead may change, and a refused field answers 403 naming it. Requires the caller\'s own autario account (API key or OAuth).',
        // Writer: create/update change autario state. Not destructive (both are
        // additive or in-place edits of the caller's own rows, nothing existing
        // is removed), not idempotent (a repeated create makes a second
        // project), and closed-world (autario's own Postgres, no external call).
        annotations: { title: 'Projects', readOnlyHint: false, autarioAuthRequired: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'objectives', 'create_objective', 'update_objective', 'create_key_result', 'update_key_result'], description: 'What to do. Default "list".' },
                group: { type: 'string', enum: ['okr', 'country', 'function', 'person'], description: 'For "list": which axis the cards are folded on. Default "okr", which is the axis that answers "does everything we do pay into something we agreed".' },
                id: { type: 'string', description: 'The id of the thing to read or change: the project for "get" and "update", the objective for "update_objective", the key result for "update_key_result".' },
                title: { type: 'string', description: 'Project title. Required for "create".' },
                brief: { type: 'string', description: 'A short description of what the project is.' },
                kind: { type: 'string', enum: ['project', 'day_to_day'], description: 'Is this a project with an end, or recurring day-to-day work? Default "project".' },
                stage: { type: 'string', enum: ['inbox', 'long_list', 'active', 'done'], description: 'Where it stands. A new project starts "active" (running); when the board owner switched on "New projects need admin approval", a non-admin\'s new project starts at "inbox" (pending review) and only an admin moves it out. "long_list" = agreed, not started; "done" = finished.' },
                owner: { type: 'string', description: 'The one person accountable for it.' },
                contributors: { type: 'array', items: { type: 'string' }, description: 'Everyone else working on it. These names are what the person axis groups by, together with the owner.' },
                country: { type: 'string', description: 'The region or country that runs it, in the account\'s own words ("DACH", "Nordics"), not an ISO code.' },
                function: { type: 'string', description: 'The function that contributes it ("Marketing", "Supply chain").' },
                resources_url: { type: 'string', description: 'A link to where the actual work lives (a drive folder, a board, a doc). http(s) only.' },
                status: { type: 'string', enum: ['green', 'amber', 'red'], description: 'The traffic light, set by a person: on track, at risk, off track.' },
                progress_pct: { type: 'integer', description: 'Progress in percent, 0 to 100, set by a person. Never derived from milestones or dates.' },
                key_result_id: { type: 'string', description: 'The id of the key result this project pays into. "list" returns the linkable ones in `key_results`; pass one of their `id` values. Omit for work that pays into nothing yet, which is exactly what the OKR axis is there to make visible.' },
                objective_id: { type: 'string', description: 'For "create_key_result": the objective it belongs to. "objectives" lists them.' },
                commitment: { type: 'string', enum: ['committed', 'aspirational'], description: 'For objectives: committed (expected at 1.0) or aspirational (0.7 is a good outcome). Changes the status rule of its key results, never a number.' },
                starts_on: { type: 'string', description: 'For objectives: start of the window its key results are paced against, YYYY-MM-DD.' },
                ends_on: { type: 'string', description: 'For objectives: end of that window, YYYY-MM-DD.' },
                target: { type: 'number', description: 'For key results: the number that counts as done. Required on create.' },
                target_reason: { type: 'string', description: 'For "update_key_result": why the target moves (ten characters or more). Required whenever `target` changes; the change is kept in the key result history.' },
                baseline: { type: 'number', description: 'For key results: where the number started. Attainment runs from baseline to target.' },
                unit: { type: 'string', description: 'For key results: the unit the number is in.' },
                direction: { type: 'string', enum: ['increase', 'decrease'], description: 'For key results: whether higher or lower is better. Default increase.' },
                manual_value: { type: 'number', description: 'For key results: the current value typed by hand. Shown as typed by hand; prefer dataset_id + value_column.' },
                dataset_id: { type: 'string', description: 'For key results: the dataset the value is read from (any dataset on this account).' },
                value_column: { type: 'string', description: 'For key results: the column of dataset_id that holds the number.' },
                filter_column: { type: 'string', description: 'For key results: optional column to filter the dataset on.' },
                filter_value: { type: 'string', description: 'For key results: the value filter_column must have.' },
                guards_id: { type: 'string', description: 'For key results: makes this key result a GUARDRAIL of that key result.' },
                guardrail_note: { type: 'string', description: 'For key results: how this number could be reached the wrong way.' },
                aggregation: { type: 'string', enum: ['sum', 'average', 'none'], description: 'For key results: how its countries add up to a region. sum (default) for counts and money, average for rates and levels, none lists the countries without a total.' },
                country_column: { type: 'string', description: 'For key results with dataset_id: the column that names the country of a row (autario_entity when the dataset has it). value_column is then read per country; a country the dataset lacks keeps its typed value.' },
                country_values: { type: 'array', description: 'For key results: the value per country, [{ country, current, target }]; country as a name or ISO code. A region total uses these; several countries without values are never split.', items: { type: 'object', properties: { country: { type: 'string' }, current: { type: 'number' }, target: { type: 'number' } }, required: ['country'] } },
                sort: { type: 'string', enum: ['board', 'effort_impact'], description: 'For "list": the order of cards inside each group. "board" (default) puts off-track work first; "effort_impact" orders by impact (5 to 1) then effort (fewest days first), unrated work last. No combined score is computed.' },
                started_at: { type: 'string', description: 'Start date, YYYY-MM-DD.' },
                target_date: { type: 'string', description: 'Target date, YYYY-MM-DD. "Due in N days" / "overdue by N days" is derived from it on every read and never stored.' },
                parent_id: { type: 'string', description: 'The project this one is part of. Projects nest at most three levels deep (programme, workstream, piece); a move that would make a fourth level or a loop is refused with a sentence. Parent progress, when the parent has none of its own, is the mean of its children and says so.' },
                budget_amount: { type: 'number', description: 'Budget. Needs budget_currency. Never converted between currencies.' },
                budget_currency: { type: 'string', description: 'Three letter currency code of the budget, e.g. EUR.' },
                spent_amount: { type: 'number', description: 'Money spent so far, typed by a person, in budget_currency.' },
                effort_days: { type: 'number', description: 'Estimated effort in person days.' },
                impact: { type: 'integer', enum: [1, 2, 3, 4, 5], description: 'Expected impact as a judgement: 1 low, 2 some, 3 clear, 4 high, 5 very high.' },
                ...FORMAT_PROP,
            },
            additionalProperties: false,
        },
    },
];

// ─── App LIFECYCLE tools (spec 2026-09-08-dai-b1-publish-door-mcp-app-tools) ─
//
// Until 2026-09-08 every app tool above was READ-only, so an LLM could describe
// autario's apps and never build one. These seven carry an app the whole way:
//
//   create_app -> update_app_manifest -> upload_app_bundle / write_app_artifact
//              -> get_app_preview_url -> publish_app  (and unpublish_app back)
//
// Each is a THIN wrapper over a REST endpoint | the platform boundary stays the
// public API, so an agent and an outside dev with curl walk the identical path
// and inherit the identical refusals (401 unauth, 402 plan limits, 403 curator
// or taken down, 404 not yours). Nothing here decides permission, and nothing
// here takes an owner or a user id as an argument: identity comes ONLY from the
// AsyncLocalStorage bearer that tools.js puts in place for the whole call, so an
// agent is exactly its owner and can never be more.
//
// Every response carries `next_step`, straight from the server, so a model finds
// the next call without reading documentation.
const APP_LIFECYCLE_TOOLS = [
    {
        name: 'create_app',
        route: 'POST /api/v1/developer/apps',
        description: 'Create a data app on autario in ONE call, owned by you. You give it a name and an entry: either an https URL where the app already runs, or the app\'s HTML itself (a single self-contained document, max 512 KB) which autario then hosts and serves inside a locked sandbox. The app id is derived from the name, so you never invent one. The new app is PRIVATE: only you can open it, it is in no catalog and at no public URL until you call publish_app. Use this as the FIRST step whenever a user asks you to build them an app, a dashboard, a report page or a tool that runs on autario data | the public catalog (World Bank, FRED, Eurostat, OECD, WHO, IMF, ECB, US Census, SEC) or the user\'s own connector tables (Google Search Console, GA4, Google Ads, Meta Ads, YouTube, TikTok, Instagram, Facebook, Shopify, LinkedIn). Inside the HTML read data with autario.js, never with fetch (the sandbox has no network): autario.ready(), autario.datasets(), autario.query(datasetId, {limit, orderBy, where}), autario.artifacts.get/set(key); autario inlines the SDK into every app, docs at https://autario.com/developer/docs/autario-js. Pass `datasets` with the ids of the user\'s own tables the app may read. Follow it with write_app_artifact (to save the app\'s data or saved views), get_app_preview_url (to hand the user a link to try) and publish_app (to make it public). Requires authentication.',
        annotations: { title: 'Create a Data App', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, autarioAuthRequired: true },
        inputSchema: {
            type: 'object',
            properties: {
                name:         { type: 'string', description: 'Display name of the app. The app id is derived from it (lowercased, hyphenated); needs at least three letters or digits.' },
                tagline:      { type: 'string', description: 'One line saying what the app does, max 200 chars. Worth writing: it is what a user reads in the app store, and an app cannot be indexed without one.' },
                entry_kind:   { type: 'string', enum: ['url', 'upload'], description: '"url" = the app already runs somewhere (give entry_url). "upload" = you are sending the app itself (give content). Default "url".' },
                entry_url:    { type: 'string', description: 'REQUIRED when entry_kind is "url". Must start with https://.' },
                content:      { type: 'string', description: 'REQUIRED when entry_kind is "upload". The app\'s entry document, normally a single self-contained HTML file. It runs in a sandbox with no outbound network: read autario data through the sandbox bridge, not through fetch to third parties.' },
                content_type: { type: 'string', enum: ['text/html', 'text/javascript', 'application/javascript'], description: 'Type of the uploaded content. Default text/html.' },
                source_url:   { type: 'string', description: 'Optional link to the app\'s open source repository.' },
                datasets:     { type: 'array', items: { type: 'string' }, description: 'Ids of the user\'s OWN datasets (connector tables, uploads; get them from get_my_workspace) this app may read through autario.js. Everyone the owner shares the app with (role reader and up) reads exactly these, nothing else. Public catalog datasets need no declaration.' },
            },
            required: ['name'],
        },
    },
    {
        name: 'update_app_manifest',
        route: 'PUT /api/v1/developer/apps/:id/manifest',
        description: 'Update the manifest of an app YOU own: its name, tagline, entry URL, version, source repository and the autario datasets or operations it is allowed to read (consumed_datasets, which is what the sandbox bridge enforces at runtime: a World Bank or FRED dataset id, a live Yahoo quote op, or the caller\'s own Google Search Console and GA4 connector tables). Only the fields you pass change; everything else on the manifest is kept. Use it to declare data access after create_app, to declare that reports of the app may be shared on a secret link (share), or to rename or re-point an existing app. An app you do not own answers "not found". This never changes who may open the app: publishing is publish_app, deliberately a separate act.',
        annotations: { title: 'Update App Manifest', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, autarioAuthRequired: true },
        inputSchema: {
            type: 'object',
            properties: {
                app_id:            { type: 'string', description: 'The app id returned by create_app.' },
                name:              { type: 'string', description: 'New display name. Omit to keep the current one.' },
                tagline:           { type: 'string', description: 'One-line description, max 200 chars.' },
                entry_url:         { type: 'string', description: 'Where the app runs. An uploaded bundle uses the conventional "index.html".' },
                version:           { type: 'string', description: 'Free-text version, e.g. "1.2.0". Bundles are stored per version.' },
                source_url:        { type: 'string', description: 'Link to the open source repository.' },
                consumed_datasets: { type: 'array', items: { type: 'object' }, description: 'What the app reads, e.g. [{"op":"datasetData","dataset":"<id>"}]. The sandbox bridge refuses any read the manifest did not declare. To read the connected accounts of whoever opens the app, add the connector keys: [{"op":"connectors","providers":["google_search_console","ga4"]}] | those providers then appear on the Settings tab of the app with the connection state of that viewer, so a user who has not connected one can connect it from inside the app. Add "optional": true and "unlocks":"<what it adds>" for a source the app works without.' },
                tier:              { type: 'integer', enum: [1, 2], description: 'Runtime model. 2 = sandboxed custom app (the default for anything you build here). Only set this if you know you need 1.' },
                share:             { type: 'object', description: 'Let a report of this app be opened on a secret read-only link, e.g. {"subjects":["account"],"sections":["meta","report"]}. "subjects" says WHOSE data a link points at and may only name kinds autario can resolve ("account" = the owner of the link, which is what a third-party app wants); "sections" is the list a link may request, and anything outside it is refused. Omit the key to leave the current setting alone. An app that has never declared this cannot be shared at all. The owner still decides per link who may open it: anyone with the URL, only signed-in people from named company domains, or only named addresses.' },
            },
            required: ['app_id'],
        },
    },
    {
        name: 'upload_app_bundle',
        route: 'POST /api/v1/developer/apps/:id/bundle',
        description: 'Upload or replace the code of an app YOU own: one self-contained entry document (HTML or JavaScript, max 512 KB, no binary). autario stores it and serves it inside a locked sandbox with no outbound network access, so the app reads World Bank, FRED, Eurostat, SEC and connector data through autario.js (autario.query, autario.datasets, autario.artifacts) rather than calling anything itself; autario inlines the SDK into the served page, so a script tag for https://autario.com/autario.js is optional. Re-uploading the same version replaces it in place. Use it to ship a new build of an app you created with create_app, or to fix one after a user reports something.',
        annotations: { title: 'Upload App Bundle', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, autarioAuthRequired: true },
        inputSchema: {
            type: 'object',
            properties: {
                app_id:       { type: 'string', description: 'The app id.' },
                content:      { type: 'string', description: 'The entry document itself.' },
                content_type: { type: 'string', enum: ['text/html', 'text/javascript', 'application/javascript'], description: 'Default text/html.' },
                version:      { type: 'string', description: 'Optional version label this bundle belongs to.' },
            },
            required: ['app_id', 'content'],
        },
    },
    {
        name: 'write_app_artifact',
        route: 'POST /api/v1/public/apps/:id/artifacts',
        description: 'Save an ARTIFACT into an app: the app\'s own output or saved state, owned by you. An artifact is what get_app_artifact reads back later | a Plotly chart specification, a saved report configuration, a board, a screener view, a table of World Bank or SEC figures the app computed. Give `type` (your own label, e.g. "chart", "report", "board"), a `title`, and `spec` and/or `data` as JSON. Pass `artifact_id` to patch one you already wrote instead of creating another. Use it right after create_app to seed the app with something real, or whenever a user asks you to save a view. You may write into any app you can open; someone else\'s private app answers "not found".',
        annotations: { title: 'Write App Artifact', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, autarioAuthRequired: true },
        inputSchema: {
            type: 'object',
            properties: {
                app_id:      { type: 'string', description: 'The app the artifact belongs to.' },
                artifact_id: { type: 'string', description: 'Omit to CREATE. Give an existing artifact id to PATCH that one.' },
                type:        { type: 'string', description: 'Your own label for the kind of artifact, e.g. "chart", "report", "board". Required when creating.' },
                title:       { type: 'string', description: 'Human title shown in the app and in get_app_artifact.' },
                spec:        { type: 'object', description: 'The saved view/configuration as JSON (e.g. a Plotly spec, a filter set).' },
                data:        { type: 'object', description: 'Optional inline data belonging to the artifact.' },
                visibility:  { type: 'string', enum: ['private', 'unlisted', 'public'], description: 'Who may read the artifact. Default private.' },
            },
            required: ['app_id'],
        },
    },
    {
        name: 'get_app_preview_url',
        route: 'GET /api/v1/developer/apps/:id/preview',
        description: 'The link to OPEN an app you own, plus where it stands. Returns preview_url (a private, never-indexed page where only you can run the app, reading World Bank, FRED, Eurostat or your own connector data through the sandbox bridge), public_url (null while the app is private, the shareable link once you publish), its visibility, whether it is indexed, and next_step: one sentence naming the next call to make. Use it to hand a user something to click after create_app, and to check what is still missing before publish_app.',
        annotations: { title: 'App Preview URL', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, autarioAuthRequired: true },
        inputSchema: {
            type: 'object',
            properties: { app_id: { type: 'string', description: 'The app id.' } },
            required: ['app_id'],
        },
    },
    {
        name: 'publish_app',
        route: 'PATCH /api/v1/developer/apps/:id/visibility',
        description: 'Publish an app YOU own. Takes effect immediately, with no review queue and nobody to ask. Two ways to publish: "public" gives it a tile in the autario app store under Community apps, next to AI Visibility 360 and the World Bank and FRED data surfaces, plus a public URL, "unlisted" gives it only the URL, so anyone you send the link to can open it and nobody else finds it. Returns public_url. Viewers read data through autario.js with their own role: a stranger sees public catalog data only, a team member the owner invited to the app (Account > Team) sees the datasets the app declares. Note that a published app is deliberately NOT search-engine indexed; only autario can put a community app into the sitemap. Use it when the user says the app is ready to share. unpublish_app reverses it.',
        annotations: { title: 'Publish App', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, autarioAuthRequired: true },
        inputSchema: {
            type: 'object',
            properties: {
                app_id:     { type: 'string', description: 'The app id.' },
                visibility: { type: 'string', enum: ['public', 'unlisted'], description: '"public" = listed in the app store. "unlisted" = link only. Default "public".' },
            },
            required: ['app_id'],
        },
    },
    {
        name: 'unpublish_app',
        route: 'PATCH /api/v1/developer/apps/:id/visibility',
        description: 'Take an app YOU own back to private: it leaves the autario app store, its public URL stops working for everyone else, and only you can still open it at its preview URL, where it keeps reading World Bank, FRED and connector data as before. Nothing is deleted, and publish_app puts it back. Use it when a user wants an app off the store, or before shipping a change they do not want strangers to see.',
        annotations: { title: 'Unpublish App', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false, autarioAuthRequired: true },
        inputSchema: {
            type: 'object',
            properties: { app_id: { type: 'string', description: 'The app id.' } },
            required: ['app_id'],
        },
    },
];

// The tool definitions carry a `route` field for the drift gate
// (__tests__/mcp/appLifecycleToolRoutes.test.js), which is not part of the MCP
// tool schema. Strip it before the union so a client never sees an unknown key.
const APP_LIFECYCLE_TOOL_ROUTES = Object.fromEntries(APP_LIFECYCLE_TOOLS.map(t => [t.name, t.route]));
const APP_LIFECYCLE_TOOL_DEFS = APP_LIFECYCLE_TOOLS.map(({ route, ...def }) => def);

// The catalog this file contributes to the MCP union: the read tools above plus
// the seven lifecycle tools.
APP_TOOLS.push(...APP_LIFECYCLE_TOOL_DEFS);

// Latest point of a series (DATA SACRED | never fabricated; null when empty).
function latestPoint(points) {
    return Array.isArray(points) && points.length ? points[points.length - 1] : null;
}

// ── app-context shaping (pure, exported for tests) ──────────────────────────
// Flatten the /apps/:id/context payload into the most token-efficient shape:
// uniform flat rows (TOON tabularizes those) and comma-joined column strings
// instead of nested arrays. No raw data rows ever pass through here.

// One flat row per resolved connector table. columns become "name:type" pairs
// in a single string so the row stays flat (TOON) and bounded.
function flattenContextTables(instances) {
    const rows = [];
    for (const inst of Array.isArray(instances) ? instances : []) {
        for (const t of Array.isArray(inst.tables) ? inst.tables : []) {
            rows.push({
                provider: inst.provider || null,
                op: t.op || null,
                dataset_id: t.dataset_id || null,
                dataset_slug: t.dataset_slug || null,
                rows: t.row_count == null ? null : t.row_count,
                last_refresh: inst.last_run_at ? String(inst.last_run_at).slice(0, 10) : null,
                columns: (t.columns || []).map(c => `${c.name}:${c.type}`).join(', '),
            });
        }
    }
    return rows;
}

// consumed_datasets entries as compact strings: "op=audience-report",
// "op=connectors providers=google_search_console,google_analytics", ...
// optional sources carry their flag + unlocks copy so an agent can tell a
// user which further connection would unlock more sections
// (spec 2026-08-08-app-data-sources-standard).
function flattenConsumed(consumed) {
    return (Array.isArray(consumed) ? consumed : []).map(e => {
        if (!e || typeof e !== 'object') return String(e);
        const parts = [];
        if (e.op) parts.push(`op=${e.op}`);
        if (e.dataset) parts.push(`dataset=${e.dataset}`);
        if (Array.isArray(e.providers) && e.providers.length) parts.push(`providers=${e.providers.join(',')}`);
        if (e.optional === true) parts.push('optional=true');
        if (e.unlocks) parts.push(`unlocks=${e.unlocks}`);
        if (e.note) parts.push(`(${e.note})`);
        return parts.join(' ') || JSON.stringify(e);
    });
}

// Compact, token-budgeted MCP view of the context payload. Never includes
// secrets (the server already redacted; this only ever narrows further).
function compactAppContext(ctx, apiBase) {
    const c = ctx && typeof ctx === 'object' ? ctx : {};
    const app = c.app || {};
    const yd = c.your_data || {};
    const instances = Array.isArray(yd.instances) ? yd.instances : [];
    const out = {
        app: app.id || null,
        name: app.name || null,
        tagline: app.tagline || null,
        url: app.route ? `${apiBase}${app.route}` : null,
        status: app.status || null,
        providers: c.providers || [],
        consumed: flattenConsumed(c.consumed_datasets),
        authenticated: !!c.authenticated,
    };
    // Agent self-description: which MCP tool returns this app's computed report
    // and which KPIs it contains. KPI rows stay flat (TOON tabularizes them).
    if (c.agent_surface && typeof c.agent_surface === 'object') {
        const s = c.agent_surface;
        out.agent_surface = {
            mcp_tool: s.mcp_tool || null,
            kpis: (Array.isArray(s.kpis) ? s.kpis : []).map(k => ({
                id: k.id, ...(k.section ? { section: k.section } : {}), label: k.label, definition: k.definition,
            })),
            ...(Array.isArray(s.example_questions) && s.example_questions.length
                ? { example_questions: s.example_questions } : {}),
        };
    }
    if (c.authenticated) {
        out.connected = !!c.connected;
        out.your_connections = instances.map(i => ({
            provider: i.provider || null,
            instance: i.instance || null,
            status: i.status || null,
            settings: Object.entries(i.settings || {}).map(([k, v]) => `${k}=${v}`).join(', ') || null,
        }));
        out.your_tables = flattenContextTables(instances);
        out.your_artifacts = (yd.artifacts || []).map(a => ({
            slug: a.slug, type: a.type, title: a.title, visibility: a.visibility,
        }));
        if (out.your_artifacts.length) {
            out.artifact_hint = 'Call get_app_artifact(app_id, slug) to load the exact saved view (spec + data) behind any of these.';
        }
    }
    out.query_examples = (c.query_examples || []).map(q => ({
        what: q.description,
        call: `${q.method} ${apiBase}${q.url}`,
    }));
    if (Array.isArray(c.hints) && c.hints.length) out.hints = c.hints;
    return out;
}

// ── workspace shaping (pure, exported for tests) ────────────────────────────
// Flatten the /apps/my/workspace payload into three uniform flat-row tables
// (apps / tables / artifacts) | TOON tabularizes those | plus per-app query
// examples. No raw data rows, no column lists (get_app_context has those).
function compactWorkspace(ws, apiBase) {
    const w = ws && typeof ws === 'object' ? ws : {};
    const apps = Array.isArray(w.apps) ? w.apps : [];
    const out = {
        my_apps: w.my_apps ?? apps.length,
        apps: apps.map(a => ({
            app: a.id,
            name: a.name || null,
            url: a.route ? `${apiBase}${a.route}` : null,
            activated: !!a.activated,
            connected: !!a.connected,
            providers: (a.providers || []).join(',') || null,
            tables: (a.tables || []).length,
            artifacts: (a.artifacts || []).length,
        })),
        tables: apps.flatMap(a => (a.tables || []).map(t => ({
            app: a.id,
            op: t.op || null,
            dataset_id: t.dataset_id || null,
            dataset_slug: t.dataset_slug || null,
            rows: t.row_count == null ? null : t.row_count,
            last_refresh: t.last_refresh ? String(t.last_refresh).slice(0, 10) : null,
        }))),
        artifacts: apps.flatMap(a => (a.artifacts || []).map(x => ({
            app: a.id, slug: x.slug, type: x.type || null, title: x.title || null, visibility: x.visibility || null,
        }))),
        query_examples: apps
            .filter(a => a.query_example)
            .map(a => ({ app: a.id, call: `${a.query_example.method} ${apiBase}${a.query_example.url}` })),
    };
    // The derived per-brand marketing table (spec 2026-09-20-metric-layer):
    // one joined row set per brand, so an agent answering "what did brand A
    // spend and earn last week" reads ONE dataset instead of re-joining three
    // connector tables with three column vocabularies. Additive and absent when
    // the caller has none.
    if (Array.isArray(w.marketing_daily) && w.marketing_daily.length) {
        out.marketing_daily = w.marketing_daily.map(m => ({
            client: m.client || null,
            dataset_id: m.dataset_id || null,
            rows: m.row_count == null ? null : m.row_count,
            last_refresh: m.last_refresh ? String(m.last_refresh).slice(0, 10) : null,
        }));
    }
    if (w.note) out.note = w.note;
    return out;
}

// ── artifact bounding (pure, exported for tests) ────────────────────────────
// An artifact's spec/data can be arbitrarily large (a plotly spec with full
// series, an inline data blob). The MCP payload stays inside a hard char
// budget by shrinking honestly: long arrays keep head+tail with an explicit
// "...N of M items truncated..." marker, long strings are sliced with an
// ellipsis, and if the whole payload still exceeds the budget the data blob is
// dropped (marked) before the spec is tightened. Counts are never faked.

const ARTIFACT_CHAR_BUDGET = 20000;

function boundValue(v, { maxArray = 40, maxString = 400, maxDepth = 12 } = {}, depth = 0) {
    if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') {
        return v.length > maxString ? v.slice(0, maxString) + `…(+${v.length - maxString} chars)` : v;
    }
    if (depth >= maxDepth) return '…(depth-truncated)';
    if (Array.isArray(v)) {
        if (v.length <= maxArray) return v.map(x => boundValue(x, { maxArray, maxString, maxDepth }, depth + 1));
        const head = Math.max(maxArray - 5, 1);
        return [
            ...v.slice(0, head).map(x => boundValue(x, { maxArray, maxString, maxDepth }, depth + 1)),
            `…(${v.length - head - 4} of ${v.length} items truncated)…`,
            ...v.slice(-4).map(x => boundValue(x, { maxArray, maxString, maxDepth }, depth + 1)),
        ];
    }
    if (typeof v === 'object') {
        const out = {};
        for (const [k, val] of Object.entries(v)) {
            out[k] = boundValue(val, { maxArray, maxString, maxDepth }, depth + 1);
        }
        return out;
    }
    return String(v);
}

// Compact, budgeted MCP view of one artifact. Three escalation stages:
// default bounds -> tight bounds -> drop `data` (keeping spec). `truncated`
// flags whether ANY shrinking happened so the model knows to re-query for
// exact rows instead of assuming completeness.
function compactArtifact(artifact) {
    const a = artifact && typeof artifact === 'object' ? artifact : {};
    const meta = {
        app: a.app_id || null,
        slug: a.slug || null,
        type: a.type || null,
        title: a.title || null,
        visibility: a.visibility || null,
        yours: !!a.yours,
        updated_at: a.updated_at || null,
    };
    const fits = (out) => JSON.stringify(out).length <= ARTIFACT_CHAR_BUDGET;

    let out = { ...meta, spec: boundValue(a.spec), data: boundValue(a.data) };
    out.truncated = JSON.stringify(out.spec) !== JSON.stringify(a.spec == null ? null : a.spec)
        || JSON.stringify(out.data) !== JSON.stringify(a.data == null ? null : a.data);
    if (fits(out)) return out;

    const tight = { maxArray: 12, maxString: 120 };
    out = { ...meta, spec: boundValue(a.spec, tight), data: boundValue(a.data, tight), truncated: true };
    if (fits(out)) return out;

    out = {
        ...meta,
        spec: boundValue(a.spec, tight),
        data: a.data == null ? null : '…(data blob omitted: too large for the MCP payload; query the app\'s datasets for exact rows)',
        truncated: true,
    };
    if (fits(out)) return out;

    // Last resort: even the tight-bounded spec busts the budget (pathological
    // key counts). Keep the top-level spec keys as a map so the model still
    // sees the SHAPE, never a silently absent field.
    const specKeys = a.spec && typeof a.spec === 'object' && !Array.isArray(a.spec) ? Object.keys(a.spec) : [];
    out.spec = `…(spec omitted: too large; top-level keys: ${specKeys.slice(0, 50).join(', ') || 'n/a'})`;
    return out;
}

// ── audience-360 report shaping (pure, exported for tests) ──────────────────
// Compact the deterministic /audience/report payload into a section-selective,
// token-bounded MCP view. DATA SACRED: values pass through unmodified (only
// display-rounded); every truncation is MARKED via an `*_omitted` count, never
// silent. No raw daily rows ever pass through (weekly series + capped top lists).

const AUD_SECTIONS = ['overview', 'channels', 'queries', 'content', 'audience', 'conversions', 'social', 'health'];
const AUD_DEFAULT_SECTIONS = ['overview', 'channels'];
const AUD_MAX_WEEKS = 13;   // ~one quarter of weekly points per series
const AUD_MAX_ROWS = 10;    // top-list rows (queries, movers, pages, countries)
const AUD_MAX_CONTENT = 15; // content quadrant rows

// Keep only scalar fields of a row (drops nested arrays/objects | weekly
// sub-series inside list rows never leak through). Non-integer numbers are
// display-rounded to 4 decimals (shares/rates), which cuts tokens without
// changing what the number says.
function scalarRow(row) {
    if (!row || typeof row !== 'object') return row;
    const out = {};
    for (const [k, v] of Object.entries(row)) {
        if (v !== null && typeof v === 'object') continue;
        out[k] = (typeof v === 'number' && !Number.isInteger(v)) ? Math.round(v * 10000) / 10000 : v;
    }
    return out;
}

// Last N entries of a list (weekly series read newest-last), scalarized, with
// an honest omitted count.
function capTail(arr, n, key) {
    const a = Array.isArray(arr) ? arr : [];
    const kept = a.slice(Math.max(0, a.length - n)).map(scalarRow);
    const out = { [key]: kept };
    if (a.length > n) out[`${key}_omitted`] = a.length - n;
    return out;
}

// First N entries (top lists are sorted best-first), scalarized, with count.
function capHead(arr, n, key) {
    const a = Array.isArray(arr) ? arr : [];
    const out = { [key]: a.slice(0, n).map(scalarRow) };
    if (a.length > n) out[`${key}_omitted`] = a.length - n;
    return out;
}

function sanitizeAudSections(sections) {
    const wanted = (Array.isArray(sections) ? sections : [])
        .map(s => String(s || '').trim().toLowerCase())
        .filter(s => AUD_SECTIONS.includes(s));
    return wanted.length ? [...new Set(wanted)] : [...AUD_DEFAULT_SECTIONS];
}

function compactAudienceReport(report, sections) {
    const r = report && typeof report === 'object' ? report : {};
    const sec = r.sections || {};
    const wanted = sanitizeAudSections(sections);
    const has = s => wanted.includes(s);

    const out = {
        app: 'Audience 360',
        window: r.filters?.window || null,
        range: r.filters?.range || null,
        days: r.days ?? null,
        connected: r.connected || null,
        brand_term: r.brand?.term || null,
        sections_returned: wanted,
        sections_available: AUD_SECTIONS,
    };
    // Incomplete parts (spec 2026-08-14): a section whose fetch failed must not
    // read as a clean zero for an agent either. Only the areas, never an error
    // message. Absent on a clean report.
    if (Array.isArray(r.degraded) && r.degraded.length) {
        out.incomplete_sections = [...new Set(r.degraded.map(d => d?.area).filter(Boolean))];
    }
    if (r.filters?.countries?.length) out.filter_countries = r.filters.countries;
    if (r.filters?.channel) out.filter_channel = r.filters.channel;
    if (Array.isArray(r.filters?.notes) && r.filters.notes.length) out.filter_notes = r.filters.notes.map(scalarRow);
    // module states as one flat map (which report modules are full/partial/locked)
    if (r.capabilities?.modules && typeof r.capabilities.modules === 'object') {
        out.modules = Object.fromEntries(
            Object.entries(r.capabilities.modules).map(([id, m]) => [id, m?.state || null])
        );
    }

    if (has('overview')) {
        // funnel is small by construction (fixed stages, few KPIs each)
        out.funnel = sec.funnel || null;
        const seg = sec.segments || {};
        out.segments = {
            window: seg.window || null,
            ...(seg.highlight ? { highlight: seg.highlight } : {}),
            ...(seg.measurable !== undefined ? { measurable: seg.measurable } : {}),
            ...(seg.totalSessions != null ? { total_sessions: seg.totalSessions } : {}),
            // headline row per segment; the heavy nested details live in the
            // channels/queries/content sections. Kept extras: the AI segment's
            // deterministic likely topics + the brand click share (interpretation
            // signal that exists nowhere else in this shape).
            list: (Array.isArray(seg.list) ? seg.list : []).map(s => ({
                id: s.id,
                channel: s.channel,
                label: s.label,
                stage: s.stage,
                measurable: !!s.measurable,
                ...(s.sessions != null ? { sessions: s.sessions } : {}),
                ...(s.share != null ? { share: Math.round(s.share * 10000) / 10000 } : {}),
                ...(Array.isArray(s.likelyTopics) && s.likelyTopics.length
                    ? { likely_topics: s.likelyTopics.slice(0, 5).map(scalarRow) } : {}),
                ...(s.split && s.split.brand ? { brand_click_share: Math.round((s.split.brand.share || 0) * 10000) / 10000 } : {}),
                ...(s.propertyReturningShare != null ? { returning_share: Math.round(s.propertyReturningShare * 10000) / 10000 } : {}),
            })),
        };
    }
    if (has('channels')) {
        const ch = sec.find?.channels || {};
        out.channels = {
            window: ch.window || null,
            totals: scalarRow(ch.totals),
            share: scalarRow(ch.share),
            total_sessions: ch.totalSessions ?? null,
            ...capTail(ch.weeks, AUD_MAX_WEEKS, 'weeks'),
        };
        const shift = sec.find?.aiShift || {};
        out.ai_share = { window: shift.window || null, ...capTail(shift.weeks, AUD_MAX_WEEKS, 'weeks') };
        out.brand_share = scalarRow(sec.find?.brandShare) || null;
    }
    if (has('queries')) {
        const look = sec.look || {};
        out.queries = {
            window: look.window || null,
            ...capHead(look.brand, AUD_MAX_ROWS, 'brand'),
            ...capHead(look.generic, AUD_MAX_ROWS, 'generic'),
            ...capHead(look.risers, AUD_MAX_ROWS, 'risers'),
            ...capHead(look.fallers, AUD_MAX_ROWS, 'fallers'),
            ...capHead(look.opportunities, AUD_MAX_ROWS, 'opportunities'),
        };
    }
    if (has('content')) {
        const content = sec.content || {};
        out.content = {
            window: content.window || null,
            ...capHead(content.rows, AUD_MAX_CONTENT, 'pages'),
        };
        if (content.aiPages) {
            out.content.ai_cited = {
                window: content.aiPages.window || null,
                total_ai_sessions: content.aiPages.totalAiSessions ?? null,
                ...capHead(content.aiPages.rows, AUD_MAX_ROWS, 'pages'),
            };
        }
        const leaders = sec.convert?.engagement?.rows;
        if (Array.isArray(leaders) && leaders.length) {
            out.content.engagement_leaders = capHead(leaders, AUD_MAX_ROWS, 'pages').pages;
        }
    }
    if (has('audience')) {
        const who = sec.who || {};
        out.audience = {
            totals: scalarRow(who.totals) || null,
            countries_window: who.countriesWindow || null,
            ...capHead(who.countries, AUD_MAX_ROWS, 'countries'),
        };
        if (who.devices) {
            out.audience.devices = {
                window: who.devices.window || null,
                ...capHead(who.devices.rows, 6, 'split'),
                ...(who.devices.totalSessions != null ? { total_sessions: who.devices.totalSessions } : {}),
            };
        }
        if (who.userTypes) {
            out.audience.user_types = {
                window: who.userTypes.window || null,
                totals: scalarRow(who.userTypes.totals) || null,
                ...(who.userTypes.newShare != null ? { new_share: Math.round(who.userTypes.newShare * 10000) / 10000 } : {}),
                ...capTail(who.userTypes.weeks, AUD_MAX_WEEKS, 'weeks'),
            };
        }
        if (who.trendWindow) out.audience.trend_window = who.trendWindow;
    }
    if (has('conversions')) {
        const conv = sec.convert?.conversions;
        if (conv && conv.reason) {
            out.conversions = { reason: conv.reason };
        } else if (conv) {
            out.conversions = {
                window: conv.window || null,
                total_key_events: conv.totalKeyEvents ?? null,
                ...capHead(conv.events, AUD_MAX_ROWS, 'events'),
                ...capTail(conv.weeks, AUD_MAX_WEEKS, 'weeks'),
            };
        } else {
            out.conversions = null;
        }
    }
    if (has('social')) {
        // Social reach + IG demographics (spec 2026-08-05-a360-social). Same
        // honesty rules: weekly series via capTail, top lists via capHead, a
        // platform without an instance reads {connected:false}, never zeros.
        const soc = sec.social || { connected: {} };
        const fb = soc.facebook;
        const ig = soc.instagram;
        const tk = soc.tiktok;
        out.social = {
            connected: soc.connected || null,
            facebook: soc.connected?.facebook ? {
                ...(fb?.daily ? {
                    window: fb.daily.window || null,
                    totals: scalarRow(fb.daily.totals),
                    total_follows: scalarRow(fb.daily.totalFollows),
                    ...capTail(fb.daily.weeks, AUD_MAX_WEEKS, 'weeks'),
                } : { reason: 'no_data' }),
                ...(fb?.posts?.rows?.length ? capHead(fb.posts.rows, AUD_MAX_ROWS, 'top_posts') : {}),
            } : { connected: false },
            instagram: soc.connected?.instagram ? {
                ...(ig?.reach ? { reach_total: ig.reach.totals?.reach ?? null, reach_window: ig.reach.window || null } : {}),
                ...(ig?.followers ? { new_followers_total: ig.followers.totals?.newFollowers ?? null, ...capTail(ig.followers.weeks, AUD_MAX_WEEKS, 'new_followers_weeks') } : {}),
                ...(ig?.totals?.rows?.length ? { totals_28d: ig.totals.rows.map(scalarRow) } : {}),
                ...(ig?.formats?.length ? { formats: ig.formats.map(scalarRow) } : {}),
                ...(ig?.posts?.rows?.length ? capHead(ig.posts.rows, AUD_MAX_ROWS, 'top_posts') : {}),
            } : { connected: false },
            tiktok: soc.connected?.tiktok ? {
                ...(tk?.account ? {
                    latest: scalarRow(tk.account.latest),
                    ...capTail(tk.account.weeks, AUD_MAX_WEEKS, 'follower_weeks'),
                } : { reason: 'no_data' }),
                ...(tk?.videos?.top?.length ? { videos_as_of: tk.videos.asOf || null, ...capHead(tk.videos.top, AUD_MAX_ROWS, 'top_videos') } : {}),
            } : { connected: false },
        };
        const demo = sec.socialAudience;
        if (demo && demo.measurable) {
            out.social.demographics = {
                as_of: demo.asOf || null,
                note: demo.note || null,
                ...Object.fromEntries(Object.entries(demo.breakdowns || {}).map(([k, rows]) => [
                    k, (rows || []).slice(0, AUD_MAX_ROWS).map(scalarRow),
                ])),
            };
        } else if (demo) {
            out.social.demographics = { reason: demo.reason || 'no_data' };
        }
    }
    if (has('health')) {
        out.health = (r.health?.connections || []).map(conn => ({
            source: conn.source,
            label: conn.label,
            property: conn.property || null,
            status: conn.status || null,
            check: conn.check || null,
            window: conn.window || null,
            checks: (conn.checks || []).map(scalarRow),
            tables: (conn.tables || []).map(scalarRow),
        }));
    }
    return out;
}

// ── seo-360 report shaping (pure, exported for tests) ───────────────────────
// Compact the deterministic /apps/seo-360/report payload into a section-
// selective, token-bounded MCP view. DATA SACRED: values pass through
// unmodified (only display-rounded via scalarRow); truncations are MARKED via
// `*_omitted` counts (capHead), never silent. Actions ride along untouched |
// they ARE the product.

// ─── projects (spec 2026-09-23-projects-app) ────────────────────────────────
//
// Token discipline, the same rule every other app tool follows: hand the model
// what it needs to answer and to make the next call, not the server's whole
// payload. The card shape is flattened (a nested `kpi` object per card becomes
// three keys) because a board of forty cards is forty repetitions of whatever
// shape this function picks.
const PROJ_MAX_CARDS = 60;

function projCard(p) {
    return {
        id: p.id,
        title: p.title,
        kind: p.kind,
        stage: p.stage,
        status: p.status,
        progress_pct: p.progress_pct,
        owner: p.owner || null,
        contributors: (p.contributors || []).length ? p.contributors : undefined,
        country: p.country || undefined,
        function: p.function || undefined,
        milestones: p.milestones && p.milestones.total ? `${p.milestones.done}/${p.milestones.total}` : undefined,
        kpi: p.kpi ? p.kpi.label : undefined,
        kpi_value: p.kpi ? p.kpi.value : undefined,
        kpi_target: p.kpi ? p.kpi.target : undefined,
        // Why there is no number, carried as the CODE; the sentence behind it
        // travels once in `kpi_reasons` instead of on every card.
        kpi_reason: p.kpi && p.kpi.value == null ? p.kpi.reason : undefined,
        // v1.1 | time, shape, cost. Derived facts travel as the server
        // computed them; nothing here recomputes a date or a roll-up.
        target_date: p.target_date || undefined,
        due: p.due && p.due.label ? p.due.label : undefined,
        parent: p.parent ? p.parent.title : undefined,
        parent_id: p.parent_id || undefined,
        sub_projects: p.child_count ? p.child_count : undefined,
        progress_from_sub_projects: p.progress_from === 'children' ? p.progress_from_count : undefined,
        progress_shown: p.progress_from === 'children' ? p.progress_effective : undefined,
        blocked_by: p.blocked ? (p.blocked_by || []).map(b => b.title) : undefined,
        budget: p.budget_amount != null ? `${p.budget_amount} ${p.budget_currency || ''}`.trim() : undefined,
        spent: p.spent_amount != null ? p.spent_amount : undefined,
        effort_days: p.effort_days != null ? p.effort_days : undefined,
        impact: p.impact != null ? p.impact : undefined,
    };
}

function compactProjects(action, payload) {
    if (action === 'list') {
        return {
            group_by: payload.group_by,
            question: payload.question,
            total: payload.total,
            inbox: (payload.inbox || []).slice(0, PROJ_MAX_CARDS).map(projCard),
            groups: (payload.groups || []).map(g => ({
                key: g.key,
                label: g.label,
                sublabel: g.sublabel || undefined,
                count: g.count,
                projects: (g.projects || []).slice(0, PROJ_MAX_CARDS).map(projCard),
                projects_omitted: g.count > PROJ_MAX_CARDS ? g.count - PROJ_MAX_CARDS : undefined,
            })),
            key_results: (payload.key_results || []).map(k => ({ id: k.id, label: k.label, objective: k.objective || undefined })),
            kpi_reasons: payload.kpi_reasons,
        };
    }
    if (action === 'get') {
        const p = payload.project || {};
        return {
            project: {
                ...projCard(p),
                brief: p.brief || undefined,
                resources_url: p.resources_url || undefined,
                okr: p.okr ? { key_result: p.okr.label, objective: p.okr.objective || undefined } : null,
            },
            milestones: payload.milestones || [],
            kpis: payload.kpis || [],
            sub_projects: (payload.children || []).map(ch => ({ id: ch.id, title: ch.title, stage: ch.stage, progress_pct: ch.progress_pct, due: ch.due && ch.due.label ? ch.due.label : undefined })),
            waits_for: ((payload.links || {}).waits_for || []).map(l => ({ id: l.project_id, title: l.title, stage: l.stage })),
            unblocks: ((payload.links || {}).unblocks || []).map(l => ({ id: l.project_id, title: l.title, stage: l.stage })),
            related: ((payload.links || {}).related || []).map(l => ({ id: l.project_id, title: l.title })),
            kpi_reasons: payload.kpi_reasons,
        };
    }
    if (action === 'objectives') {
        const kr = (k) => ({
            id: k.id,
            title: k.title,
            value: k.current,
            unit: k.unit || undefined,
            baseline: k.baseline != null ? k.baseline : undefined,
            target: k.target,
            direction: k.direction,
            source: k.value ? k.value.source : undefined,
            reason: k.current == null && k.value ? k.value.reason : undefined,
            status: k.status,
            progress_pct: k.progress_pct,
            unprotected: k.unprotected || undefined,
            breached_by: k.breached_by && k.breached_by.length ? k.breached_by.map(b => b.title) : undefined,
            guardrails: (k.guardrails || []).map(g => ({ id: g.id, title: g.title, value: g.current, target: g.target, breached: g.breached })),
            guardrail_note: k.guardrail_note || undefined,
            target_changes: (k.target_history || []).length || undefined,
            projects: (k.projects || []).map(x => x.title),
        });
        return {
            totals: payload.totals,
            objectives: (payload.objectives || []).map(o => ({
                id: o.id,
                title: o.title,
                owner: o.owner || undefined,
                commitment: o.commitment,
                window: o.starts_on || o.ends_on ? `${o.starts_on || ''} to ${o.ends_on || ''}` : undefined,
                status: o.status,
                progress_pct: o.progress_pct,
                key_results: (o.key_results || []).map(kr),
            })),
            kpi_reasons: payload.kpi_reasons,
        };
    }
    if (action === 'create_objective' || action === 'update_objective') return { objective: payload.objective || {} };
    if (action === 'create_key_result' || action === 'update_key_result') return { key_result: payload.key_result || {} };
    // create / update both answer with the row they wrote.
    return { project: projCard(payload.project || {}) };
}

const SEO_SECTIONS = ['page2_gaps', 'ctr_underperformers', 'orphan_demand', 'cannibalization', 'trends', 'rank_tracking', 'decay', 'vitals', 'audit', 'health'];
const SEO_DEFAULT_SECTIONS = ['page2_gaps', 'health'];
const SEO_MAX_ROWS = 10;

function sanitizeSeoSections(sections) {
    const wanted = (Array.isArray(sections) ? sections : [])
        .map(s => String(s || '').trim().toLowerCase())
        .filter(s => SEO_SECTIONS.includes(s));
    return wanted.length ? [...new Set(wanted)] : [...SEO_DEFAULT_SECTIONS];
}

// Cannibalization rows carry a nested pages[] array that scalarRow would drop;
// flatten it into one honest string per row ("path (share 60%, pos 6.0)").
function flattenCannibalRow(row) {
    const flat = scalarRow(row);
    flat.pages = (row.pages || [])
        .map(p => `${p.path} (share ${Math.round((p.share || 0) * 100)}%, pos ${p.position != null ? p.position : 'n/a'})`)
        .join('; ');
    return flat;
}

function compactSeoReport(report, sections) {
    const r = report && typeof report === 'object' ? report : {};
    const sec = r.sections || {};
    const wanted = sanitizeSeoSections(sections);
    const has = s => wanted.includes(s);

    const out = {
        app: 'SEO 360',
        unit: r.unit || '(query, page) pair',
        connected: r.connected !== false,
        property: r.property || null,
        window: r.window || null,
        previous_window: r.previousWindow || null,
        sections_returned: wanted,
        sections_available: SEO_SECTIONS,
    };
    if (r.connected === false || r.reason) {
        out.reason = r.reason || null;
        if (r.hint) out.hint = r.hint;
        return out;
    }
    if (r.benchmark) {
        out.benchmark = {
            source: r.benchmark.source,
            note: r.benchmark.note,
            buckets: (r.benchmark.buckets || []).map(scalarRow),
        };
    }
    // v2: the user's own click-value setting (worthEur fields on gap/decay rows)
    if (r.money) out.money = scalarRow(r.money);
    if (has('page2_gaps') && sec.page2_gaps) {
        out.page2_gaps = {
            candidates: sec.page2_gaps.candidates,
            target_position: sec.page2_gaps.targetPosition,
            ...capHead(sec.page2_gaps.rows, SEO_MAX_ROWS, 'rows'),
        };
    }
    if (has('ctr_underperformers') && sec.ctr_underperformers) {
        out.ctr_underperformers = {
            candidates: sec.ctr_underperformers.candidates,
            ...capHead(sec.ctr_underperformers.rows, SEO_MAX_ROWS, 'rows'),
        };
    }
    if (has('orphan_demand') && sec.orphan_demand) {
        out.orphan_demand = {
            candidates: sec.orphan_demand.candidates,
            ...capHead(sec.orphan_demand.rows, SEO_MAX_ROWS, 'rows'),
        };
    }
    if (has('cannibalization') && sec.cannibalization) {
        const capped = capHead(sec.cannibalization.rows, SEO_MAX_ROWS, 'rows');
        out.cannibalization = {
            candidates: sec.cannibalization.candidates,
            rows: (sec.cannibalization.rows || []).slice(0, SEO_MAX_ROWS).map(flattenCannibalRow),
            ...(capped.rows_omitted ? { rows_omitted: capped.rows_omitted } : {}),
        };
    }
    if (has('trends') && sec.trends) {
        out.trends = {
            previous_window_incomplete: !!sec.trends.previousWindowIncomplete,
            ...(sec.trends.previousCoverage ? { previous_coverage: sec.trends.previousCoverage } : {}),
            ...(sec.trends.note ? { note: sec.trends.note } : {}),
            ...capHead(sec.trends.winners, SEO_MAX_ROWS, 'winners'),
            ...capHead(sec.trends.losers, SEO_MAX_ROWS, 'losers'),
            // v2 additive: rank moves next to the click moves
            ...capHead(sec.trends.positionWinners, SEO_MAX_ROWS, 'position_winners'),
            ...capHead(sec.trends.positionLosers, SEO_MAX_ROWS, 'position_losers'),
        };
    }
    // v2 sections (spec 2026-08-08-seo-360-v2). Token discipline: per-day
    // series are capped/tail-only; per-query sparkline series are dropped (the
    // scalar current/7d/28d deltas carry the story for an agent).
    if (has('rank_tracking') && sec.rank_tracking) {
        const rt = sec.rank_tracking;
        out.rank_tracking = {
            ...capHead((rt.tracked && rt.tracked.rows) || [], SEO_MAX_ROWS, 'tracked'),
            ...(rt.tracked && rt.tracked.note ? { note: rt.tracked.note } : {}),
            pinned_queries: rt.pinnedQueries || [],
            distribution_last_days: ((rt.distribution && rt.distribution.series) || []).slice(-7).map(scalarRow),
            share_of_voice_last_days: ((rt.shareOfVoice && rt.shareOfVoice.series) || []).slice(-7).map(scalarRow),
            ...(rt.shareOfVoice && rt.shareOfVoice.note ? { share_of_voice_note: rt.shareOfVoice.note } : {}),
            brand_split: rt.brandSplit ? {
                totals: scalarRow(rt.brandSplit.totals),
                brand_terms: rt.brandSplit.brandTerms || [],
                source: rt.brandSplit.brandSource,
            } : null,
        };
    }
    if (has('decay') && sec.decay) {
        out.decay = {
            candidates: sec.decay.candidates,
            previous_window_incomplete: !!sec.decay.previousWindowIncomplete,
            ...(sec.decay.note ? { note: sec.decay.note } : {}),
            ...capHead(sec.decay.rows, SEO_MAX_ROWS, 'rows'),
        };
    }
    if (has('vitals') && sec.vitals) {
        out.vitals = sec.vitals.configured === false
            ? { configured: false, hint: sec.vitals.hint }
            : {
                configured: true,
                ...(sec.vitals.note ? { note: sec.vitals.note } : {}),
                rows: (sec.vitals.rows || []).map(r => ({
                    ...scalarRow(r),
                    ...(r.ratings ? {
                        lcp_rating: r.ratings.lcp, inp_rating: r.ratings.inp, cls_rating: r.ratings.cls,
                    } : {}),
                })),
            };
    }
    if (has('audit') && sec.audit) {
        const a = sec.audit;
        out.audit = a.available === false
            ? { available: false, hint: a.hint }
            : {
                available: true,
                status: a.status,
                host: a.host,
                pages_crawled: a.pagesCrawled,
                issue_counts: a.summary ? a.summary.issueCounts : null,
                ...(a.diff ? {
                    diff_since: a.diff.since,
                    ...capHead(a.diff.newIssues, SEO_MAX_ROWS, 'new_issues'),
                    fixed_issues_count: a.diff.fixedIssues.length,
                } : {}),
                ...capHead(a.issues, SEO_MAX_ROWS, 'issues'),
                ...capHead(a.linkOpportunities, 5, 'link_opportunities'),
                ...(a.note ? { note: a.note } : {}),
            };
    }
    if (has('health') && sec.health) {
        out.health = {
            table: scalarRow(sec.health.table),
            window: scalarRow(sec.health.window),
            previous_window: scalarRow(sec.health.previousWindow),
            pairs_analyzed: sec.health.pairsAnalyzed,
            benchmark_source: sec.health.benchmarkSource,
            stale_days: sec.health.staleDays,
            notes: sec.health.notes || [],
        };
    }
    return out;
}

// ── social-360 report shaping (pure, exported for tests) ────────────────────
// Compact the deterministic /apps/social-360/report payload into a section-
// selective, token-bounded MCP view. Same contract as compactSeoReport: values
// pass through unmodified (display-rounded via scalarRow), truncations are
// MARKED with `*_omitted` counts, and every honest not-connected / not-enough-
// data state survives into the agent's view instead of reading as a zero.

// ─── Marketing Report (spec 2026-09-20-client-marketing-report) ─────────────
//
// The page's blocks carry every metric as { value, prior, change } so the UI can
// render a number and its move from one object. An agent reads a FLAT row far
// more cheaply, so this compactor spreads each one into `spend`, `spend_prior`
// and `spend_change_pct` and drops the rest. Nothing is recomputed here: every
// number is the one the server already decided, which is the rule the whole
// file follows.
const MARKETING_SECTIONS = ['overview', 'channels', 'campaigns', 'daily'];
const MARKETING_DEFAULT_SECTIONS = ['overview'];
const MARKETING_MAX_ROWS = 25;
const MARKETING_MAX_DAYS = 92;

function sanitizeMarketingSections(sections) {
    const wanted = (Array.isArray(sections) ? sections : [])
        .map(s => String(s || '').trim().toLowerCase())
        .filter(s => MARKETING_SECTIONS.includes(s));
    return wanted.length ? [...new Set(wanted)] : [...MARKETING_DEFAULT_SECTIONS];
}

// One { value, prior, change } pair -> up to three flat keys. A null stays null
// (an honest dash); it never becomes 0, because "nobody reported this" and "the
// total is zero" are different answers and this app exists to keep them apart.
function flatMetric(out, name, pair) {
    if (!pair || typeof pair !== 'object') return;
    out[name] = pair.value;
    if (pair.prior !== null && pair.prior !== undefined) out[`${name}_prior`] = pair.prior;
    if (pair.change && pair.change.pct !== null && pair.change.pct !== undefined) {
        out[`${name}_change_pct`] = Math.round(pair.change.pct * 10000) / 10000;
    }
}

function flatMarketingRow(row, fields) {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
        if (v === null || typeof v !== 'object') out[k] = v;
    }
    for (const f of fields) flatMetric(out, f, row[f]);
    // A refused (mixed currency) row carries WHY, and that sentence IS the
    // answer, so it survives the flattening.
    if (row.reason) out.reason = row.reason;
    if (Array.isArray(row.currencies) && row.currencies.length > 1) out.currencies = row.currencies.join(', ');
    return out;
}

const MARKETING_KPI_FIELDS = ['spend', 'conversions', 'revenue', 'conversion_value', 'roas', 'cpa'];
const MARKETING_CHANNEL_FIELDS = [...MARKETING_KPI_FIELDS, 'impressions', 'clicks', 'orders', 'ctr', 'cpc'];

function compactMarketingReport(report, sections) {
    const r = report && typeof report === 'object' ? report : {};
    const wanted = sanitizeMarketingSections(sections);
    const has = s => wanted.includes(s);

    const out = {
        app: 'Marketing Report',
        unit: 'brand, channel, campaign and day',
        // Always listed: a first call without `brand` must tell the agent what
        // it could have passed, instead of leaving it to guess a uuid.
        brands: (r.brands || r.clients || []).map(c => scalarRow(c)),
        brand: (r.brand || r.client) ? scalarRow(r.brand || r.client) : null,
        period: r.period ? {
            preset: r.period.preset, label: r.period.label,
            from: r.period.from, to: r.period.to, days: r.period.days,
            compared_to: `${r.period.prior ? r.period.prior.from : null} to ${r.period.prior ? r.period.prior.to : null}`,
            compared_to_note: r.period.prior_label,
        } : null,
        sections_returned: wanted,
        sections_available: MARKETING_SECTIONS,
        state: r.state || null,
    };

    // The four named empty states, each of which needs a DIFFERENT action. An
    // agent must be able to say which one, so the headline and the detail ride
    // out rather than being flattened into "no data".
    if (r.state && r.state !== 'ok') {
        out.headline = r.headline || null;
        out.detail = r.detail || null;
        if (r.action) out.next_step = `${r.action.label}: https://autario.com${r.action.href}`;
        if (r.health) out.health = (r.health || []).map(h => scalarRow(h));
        return out;
    }

    if (r.dataset) {
        out.table_built_at = r.dataset.built_at;
        if (r.dataset.truncated) out.truncated = true;
    }

    if (has('overview')) {
        if (r.kpis) {
            out.totals = flatMarketingRow(r.kpis, MARKETING_KPI_FIELDS);
            // The measured case this exists for: Meta reports EUR and the
            // Google Ads campaign report publishes no currency code at all, so
            // the combined total is refused. One real total per currency is the
            // usable answer, and it is never summed into one.
            out.totals_by_currency = (r.kpis.by_currency || []).map(b => scalarRow(b));
        }
        out.health = (r.health || []).map(h => scalarRow(h));
        out.definitions = (r.definitions || []).map(d => `${d.formula}. ${d.definition}`);
        out.honesty = r.honesty || [];
    }

    if (has('channels')) {
        out.channels = (r.channels || []).map(c => flatMarketingRow(c, MARKETING_CHANNEL_FIELDS));
    }

    if (has('campaigns') && r.campaigns) {
        out.campaigns_total = r.campaigns.total;
        out.campaigns_by_spend = (r.campaigns.by_spend || [])
            .slice(0, MARKETING_MAX_ROWS).map(c => flatMarketingRow(c, MARKETING_KPI_FIELDS));
        out.campaigns_by_roas = (r.campaigns.by_roas || [])
            .slice(0, MARKETING_MAX_ROWS).map(c => flatMarketingRow(c, MARKETING_KPI_FIELDS));
    }

    if (has('daily')) {
        const days = r.daily || [];
        out.daily = days.slice(-MARKETING_MAX_DAYS).map(d => scalarRow(d));
        // A day that reported nothing is ABSENT from this list rather than
        // present as a zero, so the count is said out loud: an agent comparing
        // it to the window length can see the holes.
        out.daily_days_reported = days.length;
    }

    return out;
}

const SOCIAL_SECTIONS = ['score', 'explorer', 'posts', 'activity', 'geo', 'spikes', 'peers', 'financials', 'findings', 'health'];
const SOCIAL_DEFAULT_SECTIONS = ['score', 'health'];
const SOCIAL_MAX_ROWS = 10;

function sanitizeSocialSections(sections) {
    const wanted = (Array.isArray(sections) ? sections : [])
        .map(s => String(s || '').trim().toLowerCase())
        .filter(s => SOCIAL_SECTIONS.includes(s));
    return wanted.length ? [...new Set(wanted)] : [...SOCIAL_DEFAULT_SECTIONS];
}

function compactSocialReport(report, sections) {
    const r = report && typeof report === 'object' ? report : {};
    const sec = r.sections || {};
    const wanted = sanitizeSocialSections(sections);
    const has = s => wanted.includes(s);

    const out = {
        app: 'Social 360',
        unit: r.unit || 'social account and post',
        connected: r.connected || {},
        any_connected: r.anyConnected !== false,
        window_days: r.window ? r.window.days : null,
        sections_returned: wanted,
        sections_available: SOCIAL_SECTIONS,
        platforms: (r.platforms || []).map(p => scalarRow(p)),
    };
    if (r.anyConnected === false || r.reason) {
        out.reason = r.reason || null;
        if (r.hint) out.hint = r.hint;
        return out;
    }
    if (has('score') && sec.score) {
        out.score = {
            blended: sec.score.blended ? scalarRow(sec.score.blended) : null,
            ...(sec.score.note ? { note: sec.score.note } : {}),
            platforms: (sec.score.platforms || []).map(p => ({
                ...scalarRow(p),
                // Components carry WHY a part is missing | the honest core of
                // the index. Flattened to one string so scalarRow keeps it.
                components: (p.components || [])
                    .map(c => `${c.id}=${c.available ? c.value : `n/a (${c.reason})`}`)
                    .join('; '),
            })),
            // Trend: tail only (the direction, not every day) for token discipline.
            trend_tail: (sec.score.trend || []).slice(-7).map(scalarRow),
        };
    }
    if (has('posts') && sec.posts) {
        const p = sec.posts;
        out.posts = {
            sorted_by: p.sortedBy,
            ...capHead(p.top, SOCIAL_MAX_ROWS, 'top'),
            formats: (p.formats && p.formats.rows ? p.formats.rows : []).map(scalarRow),
            ...(p.formats && p.formats.note ? { formats_note: p.formats.note } : {}),
            frequency: p.frequency ? {
                correlation: p.frequency.correlation,
                verdict: p.frequency.verdict,
                weeks: (p.frequency.weeks || []).map(scalarRow),
            } : null,
            // v2 replaced the best-time heatmap (a cross-timezone "best hour"
            // was true for nobody) with per-post effectiveness.
            effectiveness: p.effectiveness ? {
                scored: p.effectiveness.scored,
                unscored: p.effectiveness.unscored,
                min_sample: p.effectiveness.minSample,
                note: p.effectiveness.note,
                ...capHead((p.effectiveness.rows || []).map(scalarRow), SOCIAL_MAX_ROWS, 'rows'),
            } : null,
        };
    }
    if (has('explorer') && sec.explorer) {
        const e = sec.explorer;
        // The full per-day series would be thousands of numbers, so the agent
        // gets the WINDOW TOTAL per channel per KPI plus the support matrix
        // (which is the part that keeps it from reporting a missing number as
        // zero). The app renders the series; an agent answers with the totals.
        out.explorer = {
            window: e.window || null,
            kpis: (e.kpis || []).map(k => ({
                id: k.id,
                label: k.label,
                aggregation: k.agg,
                definition: k.definition,
                not_reported_by: Object.entries(k.platforms || {})
                    .filter(([, v]) => v.supported === false)
                    .map(([p_, v]) => `${p_}: ${v.reason}`),
            })),
            ...capHead((e.channels || []).map(c => ({
                channel: c.label,
                platform: c.platform,
                tags: (c.tags || []).join(', '),
                posts_in_window: c.postsInWindow,
                ...Object.fromEntries(Object.entries(c.totals || {}).map(([k, v]) => [`total_${k}`, v])),
            })), SOCIAL_MAX_ROWS, 'channels'),
            note: e.note,
        };
    }
    if (has('geo') && sec.geo) {
        out.geo = {
            metrics: (sec.geo.metrics || []).map(m => ({
                id: m.id,
                label: m.label,
                total: m.total,
                reason: m.reason,
                ...capHead((m.countries || []).map(scalarRow), SOCIAL_MAX_ROWS, 'countries'),
            })),
            notes: sec.geo.notes || [],
        };
    }
    if (has('spikes') && sec.spikes) {
        out.spikes = {
            ...(sec.spikes.note ? { note: sec.spikes.note } : {}),
            ...capHead((sec.spikes.rows || []).map(s => ({
                ...scalarRow(s),
                candidates: (s.candidates || []).map(c => `${c.platform}: ${c.text || c.id}`).join('; '),
            })), SOCIAL_MAX_ROWS, 'rows'),
        };
    }
    if (has('peers') && sec.peers) {
        out.peers = sec.peers.available === false
            ? { available: false, reason: sec.peers.reason, hint: sec.peers.hint }
            : {
                available: true,
                you: sec.peers.you ? scalarRow(sec.peers.you) : null,
                ...(sec.peers.note ? { note: sec.peers.note } : {}),
                ...capHead((sec.peers.rows || []).map(scalarRow), SOCIAL_MAX_ROWS, 'rows'),
            };
    }
    if (has('financials') && sec.financials) {
        const f = sec.financials;
        out.financials = f.available === false
            ? { available: false, hint: f.hint || f.error || null, sources: (f.sources || []).map(scalarRow) }
            : {
                available: true,
                sources: (f.sources || []).map(scalarRow),
                accounts: (f.accounts || []).map(scalarRow),
                spend_by_currency: (f.spendByCurrency || []).map(scalarRow),
                ...capHead((f.campaigns || []).map(scalarRow), SOCIAL_MAX_ROWS, 'campaigns'),
                ...(f.campaignsOmitted > 0 ? { campaigns_beyond_app_cap: f.campaignsOmitted } : {}),
                paid_vs_organic: f.paidVsOrganic ? {
                    organic: f.paidVsOrganic.organic ? scalarRow(f.paidVsOrganic.organic) : null,
                    paid: f.paidVsOrganic.paid ? scalarRow({ ...f.paidVsOrganic.paid, spendByCurrency: undefined }) : null,
                    note: f.paidVsOrganic.note,
                } : null,
                notes: f.notes || [],
            };
    }
    if (has('activity') && sec.activity) {
        // Activity table (spec 2026-09-15-onboarding-build-social-activity):
        // the per-dimension pivots and the what-works groups are the answer
        // an agent needs; the full row list is capped (the app renders it).
        const a = sec.activity;
        const pivots = {};
        for (const [dim, rows] of Object.entries(a.dimensions || {})) {
            pivots[dim] = capHead((rows || []).map(scalarRow), SOCIAL_MAX_ROWS, 'rows');
        }
        out.activity = {
            coverage: a.coverage || null,
            pivots,
            what_works: {
                ...capHead((a.combos && a.combos.rows ? a.combos.rows : []).map(scalarRow), SOCIAL_MAX_ROWS, 'rows'),
                note: a.combos ? a.combos.note : null,
            },
            topics: (a.topics || []).map(t => t.name),
            ...capHead((a.rows || []).map(r => scalarRow({
                day: r.day, platform: r.platform, channel: r.channelLabel, id: r.id,
                content_type: r.contentType, post_type: r.postType, topic: r.topic,
                sentiment: r.sentiment, language: r.language, engagement: r.engagement,
                views: r.views, reach: r.reach, text: r.text,
            })), SOCIAL_MAX_ROWS, 'posts'),
            note: a.note,
        };
    }
    if (has('findings') && sec.findings) {
        // v3 final (spec D7): the deterministic works / needs-attention list.
        // Text, hedged reading and the evidence line pass through verbatim:
        // the evidence IS the finding's licence to exist.
        out.findings = {
            ...capHead((sec.findings.works || []).map(f => ({
                finding: f.text, reading: f.reading, evidence: f.evidence,
            })), SOCIAL_MAX_ROWS, 'works'),
            ...capHead((sec.findings.attention || []).map(f => ({
                finding: f.text, reading: f.reading, evidence: f.evidence,
            })), SOCIAL_MAX_ROWS, 'needs_attention'),
            note: sec.findings.note,
        };
    }
    if (has('health') && sec.health) {
        out.health = {
            window_days: sec.health.windowDays,
            platforms: Object.fromEntries(
                Object.entries(sec.health.platforms || {}).map(([k, v]) => [k, scalarRow(v)])
            ),
            notes: sec.health.notes || [],
        };
    }
    return out;
}

// ── ai-visibility-360 report shaping (pure, exported for tests) ─────────────
// Compact the deterministic /api/visibility payloads into a section-selective,
// token-bounded MCP view. Same contract as the other 360 shapers: values pass
// through unmodified (display-rounded via scalarRow), truncations are MARKED
// with `*_omitted` counts, and every honest null / not-linked / no-data state
// survives into the agent's view instead of reading as a zero.

const VIS_SECTIONS = ['overview', 'prompts', 'sources', 'actions', 'answers', 'impact', 'searches', 'movers', 'pages', 'crawlability', 'perception', 'action_effects',
    // spec 2026-09-12-vis-peec-gaps-p0
    'gaps', 'model_rankings'];
const VIS_DEFAULT_SECTIONS = ['overview'];
const VIS_MAX_ROWS = 10;
const VIS_MAX_PROMPTS = 20;
const VIS_MAX_ANSWERS = 10;
const VIS_ANSWER_CHARS = 500;

function sanitizeVisSections(sections) {
    const wanted = (Array.isArray(sections) ? sections : [])
        .map(s => String(s || '').trim().toLowerCase())
        .filter(s => VIS_SECTIONS.includes(s));
    return wanted.length ? [...new Set(wanted)] : [...VIS_DEFAULT_SECTIONS];
}

// Honest truncation: cap a string with an explicit marker, never silently.
function visTruncate(s, max) {
    const str = String(s == null ? '' : s);
    return str.length > max ? str.slice(0, max) + `…(+${str.length - max} chars)` : str;
}

// "Name (0.42)" | the compact top-competitor cell used by prompts/categories.
function visCompetitorCell(tc) {
    if (!tc || typeof tc !== 'object' || !tc.name) return null;
    return tc.score != null ? `${tc.name} (${tc.score})` : String(tc.name);
}

// WHICH prompts a payload's numbers counted (spec 2026-09-18-vis-unbranded-
// headline, extended to every read surface by 2026-09-19-vis-unbranded-all-
// views). ONE reshape, used by the report AND by the standalone sections
// (sources, searches, movers, gaps, pages, perception, action effects), all of
// which now publish the same block: an agent quoting a number from any of them
// has to know it excludes questions that name the brand. Never summed with the
// branded half. null when the payload carries no block.
function compactVisPopulation(payload) {
    const p = payload && typeof payload === 'object' ? payload.population : null;
    if (!p || typeof p !== 'object') return null;
    return {
        scope: p.scope,
        counts_only_prompts_that_do_not_name_you: p.scope === 'unbranded',
        unbranded_prompts: p.unbranded?.prompts ?? null,
        unbranded_answers: p.unbranded?.answers ?? null,
        branded_prompts: p.branded?.prompts ?? null,
        branded_answers: p.branded?.answers ?? null,
        only_branded: !!p.only_branded,
        ...(p.headline ? { headline: p.headline } : {}),
        ...(p.note ? { note: p.note } : {}),
    };
}

// The overview / prompts / sources sections all come out of ONE /report read.
function compactVisibilityReport(report, sections) {
    const r = report && typeof report === 'object' ? report : {};
    const wanted = sanitizeVisSections(sections);
    const has = s => wanted.includes(s);

    const out = {
        app: 'AI Visibility 360',
        brand: r.brand?.name || null,
        focus: r.focus?.name || null,
        window: r.window ? scalarRow(r.window) : null,
        sections_returned: wanted,
        sections_available: VIS_SECTIONS,
        // Two scales live in this report BY CONTRACT (the app renders both):
        // named here so an agent never mixes them up.
        units: 'visibility.score, leaderboard scores, brand_score and citation shares are 0..1 fractions; rankings.visibility/sov/sentiment are 0..100.',
    };

    // spec 2026-09-18-vis-unbranded-headline: WHICH prompts these numbers
    // count. Present on EVERY section set, because a caller that asked for
    // `sources` and quotes the brand's visibility from a previous call still
    // has to know the default excludes questions naming the brand. Never
    // summed with the branded block.
    const pop = compactVisPopulation(r);
    if (pop) out.population = pop;

    if (has('overview')) {
        const v = r.visibility || {};
        out.visibility = {
            score: v.score ?? null,
            delta: v.delta ?? null,
            rank: v.rank ?? null,
            rank_delta: v.rank_delta ?? null,
            granularity: v.granularity || null,
            ...capTail(v.series, 14, 'series'),
        };
        if (v.run_comparison) out.visibility.run_comparison = scalarRow(v.run_comparison);
        out.leaderboard = capHead((v.leaderboard || []).map(scalarRow), VIS_MAX_ROWS, 'rows');
        // rankings carry sentiment/sov/position (0..100 + rank); null stays
        // null = "no data", which is a different fact from 0.
        out.rankings = capHead((r.rankings || []).map(scalarRow), VIS_MAX_ROWS, 'rows');
        // The branded half, measured on its own. Absent when the brand has no
        // prompt naming it; never added to `rankings`.
        if (Array.isArray(r.rankings_branded) && r.rankings_branded.length) {
            out.rankings_branded = capHead(r.rankings_branded.map(scalarRow), VIS_MAX_ROWS, 'rows');
        }
        const p = r.platforms || {};
        out.platforms = {
            providers: p.providers || [],
            models: p.models || {},
            ...(p.failures && Object.keys(p.failures).length ? { failures: p.failures } : {}),
            // per-provider scores flattened into the row (TOON tabularizes).
            ...capHead((p.rows || []).map(row => ({
                name: row.name, owned: !!row.owned, total: row.total ?? null,
                ...Object.fromEntries(Object.entries(row.scores || {}).map(([k, s2]) => [k, s2])),
            })), VIS_MAX_ROWS, 'rows'),
        };
    }
    if (has('prompts')) {
        out.prompts = capHead((r.prompts || []).map(p2 => ({
            id: p2.id ?? null,
            topic: p2.topic || null,
            category: p2.category || null,
            text: p2.text || null,
            answers: p2.answers ?? null,
            brand_score: p2.brand_score ?? null,
            top_competitor: visCompetitorCell(p2.top_competitor),
            // spec 2026-09-06-vis-prompt-intent
            ...(p2.intent ? { intent: p2.intent } : {}),
            ...(p2.branded != null ? { branded: !!p2.branded } : {}),
            // spec 2026-09-18: names the OWNED brand, the split the score uses
            ...(p2.names_you != null ? { names_you: !!p2.names_you } : {}),
        })), VIS_MAX_PROMPTS, 'rows');
        out.prompt_categories = (r.categories || []).map(c => ({
            category: c.category, answers: c.answers ?? null,
            brand_score: c.brand_score ?? null,
            top_competitor: visCompetitorCell(c.top_competitor),
        }));
    }
    if (has('sources')) {
        const c = r.citations || {};
        out.sources = {
            citation_capable_providers: c.available_providers || [],
            own_share: c.share ?? null,
            delta: c.delta ?? null,
            rank: c.rank ?? null,
            total_answers: c.total_answers ?? null,
            citable_answers: c.citable_answers ?? null,
            ...capHead((c.leaderboard || []).map(scalarRow), VIS_MAX_ROWS, 'domains'),
        };
    }
    return out;
}

// GET /brands/:id/actions answers per bucket: {cards, categories, topDomains, ...}.
// Cards ARE the product here; phrases/themes stay in the app (evidence UI).
function compactVisibilityActions(owned, earned) {
    const cardRow = (card) => ({
        id: card.id ?? null,
        bucket: card.bucket || null,
        category: card.category || null,
        impact: card.impact || null,
        status: card.status || null,
        text: card.text || null,
        ref_domain: card.ref_domain || null,
        ref_url: card.ref_url || null,
    });
    return {
        ...capHead(((earned && earned.cards) || []).map(cardRow), VIS_MAX_ROWS, 'earned'),
        ...capHead(((owned && owned.cards) || []).map(cardRow), VIS_MAX_ROWS, 'owned'),
        owned_category_strength: ((owned && owned.categories) || []).map(scalarRow),
        ...capHead(((earned && earned.topDomains) || []).map(scalarRow), VIS_MAX_ROWS, 'top_cited_domains'),
    };
}

// GET /answers answers {total, days, items}; items carry full texts + mention
// objects. Kept: the citable core per answer, honestly shortened | plus
// cut_off_by_model, which is a fact about the ANSWER, not about this reshape.
function compactVisibilityAnswers(payload) {
    const items = Array.isArray(payload?.items) ? payload.items
        : (Array.isArray(payload) ? payload : []);
    return {
        total: payload?.total ?? items.length,
        // spec 2026-09-12-vis-peec-gaps-p0 gap 31: the KPI strip of the Chats
        // table, so an agent gets the shape of the set before its rows.
        ...(payload?.stats ? { stats: payload.stats } : {}),
        ...capHead(items.map(a => ({
            provider: a.provider || null,
            model: a.model || null,
            date: a.created_at ? String(a.created_at).slice(0, 10) : null,
            prompt: a.prompt_text ? visTruncate(a.prompt_text, 160) : null,
            // spec 2026-09-19-vis-unbranded-all-views: this list keeps EVERY
            // answer (it is the evidence browser), so each row says whether its
            // question already named the brand. Only present when true, so an
            // absent flag is never read as a claimed false.
            ...(a.names_you ? { question_names_your_brand: true } : {}),
            ...(a.error ? { error: visTruncate(a.error, 160) } : {}),
            mentions: (a.mentions || []).map(m => m.name).join(', ') || null,
            cited_domains: (a.cited_domains || []).slice(0, 8).join(', ') || null,
            // gap 12: what the assistant DID and where the perspective brand
            // landed in the answer. Absent when the vendor recorded nothing /
            // the answer does not name the brand, never a claimed zero.
            ...(a.feature == null ? {} : { feature: a.feature }),
            ...(a.position == null ? {} : { position: a.position }),
            // 2026-08-24 (spec 2026-08-24-vis-answer-truncation): TWO different
            // shortenings must not be confused. `text` may be shortened HERE
            // for token economy (the marker says so); `cut_off_by_model` says
            // the ASSISTANT stopped at its own length limit, so the stored
            // answer itself is a fragment. Only present when the vendor
            // reported a reason: absent = honestly unknown, never a false.
            ...(a.truncated == null ? {} : { cut_off_by_model: !!a.truncated }),
            text: a.error ? null : visTruncate(a.text, VIS_ANSWER_CHARS),
        })), VIS_MAX_ANSWERS, 'answers'),
    };
}

// GET /brands/:id/sources (spec 2026-09-05 blocks): the three window-level
// extras ride on the same payload. Each is shaped separately so an agent can
// ask for exactly one.
function compactVisibilitySearches(payload) {
    const s = payload && payload.searches && typeof payload.searches === 'object' ? payload.searches : {};
    return {
        distinct_queries: s.distinct ?? 0,
        total_queries: s.total ?? 0,
        answers_recorded: s.answers_recorded ?? 0,
        answers_with_searches: s.answers_with_searches ?? 0,
        providers: s.providers || {},
        ...capHead((s.topics || []).map(t => ({
            topic: t.topic, queries: t.count,
            top: (t.queries || []).slice(0, 5).map(q => `${q.query} (${q.occurrences})`).join('; ') || null,
        })), VIS_MAX_ROWS, 'topics'),
        ...capHead((s.brands || []).map(scalarRow), VIS_MAX_ROWS, 'brands_in_searches'),
        ...capHead((s.terms || []).map(scalarRow), VIS_MAX_ROWS, 'terms'),
    };
}
function compactVisibilityMovers(payload) {
    const m = payload && payload.movers && typeof payload.movers === 'object' ? payload.movers : {};
    const rows = (list) => (list || []).map(r => ({ domain: r.domain, type: r.type, answers: r.answers, used_pct: r.usedPct, prev_used_pct: r.prevUsedPct, change_pts: r.delta }));
    return {
        previous_window: m.previous ? scalarRow(m.previous) : null,
        ...capHead(rows(m.top), VIS_MAX_ROWS, 'top'),
        ...capHead(rows(m.new), VIS_MAX_ROWS, 'new'),
        ...capHead(rows(m.trending), VIS_MAX_ROWS, 'trending'),
        ...capHead(rows(m.losing), VIS_MAX_ROWS, 'losing'),
    };
}
// GET /brands/:id/sources?view=gaps (spec 2026-09-12-vis-peec-gaps-p0, gap 22):
// the sources that cite a competitor and never the brand, with the four rates
// the app defines. There is deliberately no "retrieval rate": we observe what
// was cited, never what an assistant read and dropped.
function compactVisibilityGaps(payload) {
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    return {
        citable_answers: payload?.citableAnswers ?? null,
        ...capHead(rows.map(r => ({
            source: r.domain, domain_type: r.type,
            gap_score_pct: r.gapScore, used_as_source_pct: r.usedPct,
            prompt_coverage_pct: r.promptPct, competitor_rate_pct: r.competitorPct,
            competitors: Array.isArray(r.competitorNames) ? r.competitorNames.join(', ') : null,
            gap_answers: r.answers, prompts: r.prompts,
            bookmarked: r.bookmarked ?? null,
        })), VIS_MAX_ROWS, 'gaps'),
    };
}
// gap 16: the platform matrix read as an ORDER, one list per assistant, so an
// agent can answer "who is ahead of us on Gemini" without re-sorting the grid.
function compactVisibilityModelRankings(report) {
    const platforms = report?.platforms || {};
    const providers = Array.isArray(platforms.providers) ? platforms.providers : [];
    const rows = Array.isArray(platforms.rows) ? platforms.rows : [];
    const seat = new Map(rows.map((r, i) => [r.name, i]));
    const out = {};
    for (const p of providers) {
        const scored = rows
            .map(r => ({ name: r.name, owned: !!r.owned, score: Number(r?.scores?.[p]) }))
            .filter(r => Number.isFinite(r.score))
            .sort((a, b) => (b.score - a.score) || (seat.get(a.name) - seat.get(b.name)));
        // An assistant with no scored answer gets an EMPTY list, not a missing
        // key: "nothing to rank" is a fact worth returning.
        out[p] = scored.map((r, i) => ({ rank: i + 1, brand: r.name, owned: r.owned, score: r.score }));
    }
    return out;
}
// GET /brands/:id/sources?view=urls: the cited pages with their page facts.
function compactVisibilityPages(payload) {
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    return {
        citable_answers: payload?.citableAnswers ?? null,
        ...capHead(rows.map(r => ({
            url: r.url, domain: r.domain, domain_type: r.type,
            citing_answers: r.answers, used_pct: r.usedPct,
            page_state: r.pageState || null,
            title: r.title || null, page_type: r.urlType || null,
            names_on_page: Array.isArray(r.mentions) ? (r.mentions.join(', ') || 'none') : null,
            page_gap: r.pageGap ?? null,
        })), VIS_MAX_ROWS * 2, 'pages'),
    };
}
// GET /brands/:id/crawlability: verdict per crawler per domain, flattened.
function compactVisibilityCrawlability(payload) {
    const crawlers = Array.isArray(payload?.crawlers) ? payload.crawlers : [];
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    return {
        crawlers_as_of: payload?.as_of || null,
        ...capHead(rows.map(r => ({
            domain: r.domain, role: r.role, state: r.state, robots: r.robots, llms_txt: r.llms_txt,
            blocked: Array.isArray(r.blocked) ? (r.blocked.map(k => (crawlers.find(c => c.key === k) || {}).ua || k).join(', ') || 'none') : null,
            partial: Array.isArray(r.partial) ? (r.partial.map(k => (crawlers.find(c => c.key === k) || {}).ua || k).join(', ') || 'none') : null,
        })), VIS_MAX_ROWS * 2, 'domains'),
    };
}
// GET /brands/:id/perception: word x brand, flattened per word.
function compactVisibilityPerception(payload) {
    const brands = Array.isArray(payload?.brands) ? payload.brands : [];
    const words = Array.isArray(payload?.words) ? payload.words : [];
    return {
        answers: payload?.answers ?? null,
        brands: brands.map(scalarRow),
        ...capHead(words.map(w => ({
            word: w.word, total: w.total,
            ...Object.fromEntries(brands.map(b => [b.name, (w.cells && w.cells[b.name]) ? w.cells[b.name].count : 0])),
        })), VIS_MAX_ROWS * 2, 'words'),
        note: 'Counts = answers whose sentence window around that brand carries the word (same sentence rule as the app\'s Phrases panel). Deterministic, not an AI reading.',
    };
}
// GET /brands/:id/actions/impact: before / after per done card.
function compactVisibilityActionEffects(payload) {
    const list = Array.isArray(payload?.effects) ? payload.effects : [];
    return {
        window_days: payload?.windowDays ?? null,
        done_cards: payload?.doneCount ?? list.length,
        ...capHead(list.map(e => ({
            id: e.id, bucket: e.bucket, done_on: e.doneAt ? String(e.doneAt).slice(0, 10) : null,
            action: visTruncate(e.text, 160),
            visibility_before: e.before ? e.before.visibility : null, answers_before: e.before ? e.before.answers : null,
            visibility_after: e.after ? e.after.visibility : null, answers_after: e.after ? e.after.answers : null,
            change: e.delta ?? null, state: e.state,
        })), VIS_MAX_ROWS, 'effects'),
        note: 'Change is what happened AFTER the done date, not proof the action caused it.',
    };
}

// GET /brands/:id/impact | already honest by construction (v9 B9): available
// false carries the reason (not linked / link broken / no data). Passed through
// with the series tail-capped.
function compactVisibilityImpact(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    if (!p.available) {
        return { available: false, reason: p.reason || null };
    }
    return {
        available: true,
        source: p.source || null,
        window: p.window ? scalarRow(p.window) : null,
        total_sessions: p.totalSessions ?? null,
        // spec 2026-09-05-vis-impact-actions: per assistant + the prior window
        ...(p.headline ? { headline: p.headline } : {}),
        ...(p.prior ? { prior_window: scalarRow(p.prior) } : {}),
        ...capHead((p.byAssistant || []).map(scalarRow), VIS_MAX_ROWS, 'by_assistant'),
        ...capTail(p.series, 14, 'series'),
        ...capHead((p.topPages || []).map(scalarRow), VIS_MAX_ROWS, 'top_pages'),
    };
}

// A cold ticker (not yet in the catalog) is live-fetched within the same call so
// the LLM gets one clean answer after a short wait. This bound keeps that wait
// short: a slow SEC fetch can't hang the tool past an MCP client's timeout. The
// server keeps ingesting after an abort (ensure is price-first, so the price
// usually lands inside the bound; remaining fundamentals show up on the next call).
const ENSURE_TIMEOUT_MS = 25000;

// POST the on-demand ensure endpoint with a hard time bound. Returns parsed JSON
// ({status:'ready'|'price-only'|'invalid'}) on success, or null on timeout/error
// | caller just re-checks /metrics afterwards. 404 carries {status:'invalid'},
// so it is parsed (not treated as a hard failure).
async function postEnsureBounded(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const r = await fetch(url, { method: 'POST', signal: ctrl.signal });
        if (!r.ok && r.status !== 404) return null;
        return await r.json().catch(() => null);
    } catch {
        return null; // abort or network error | re-check /metrics anyway
    } finally {
        clearTimeout(timer);
    }
}

// Valid view params (mirror the app's own enums). Invalid values are dropped so
// the URL carries only what the SPA understands | the app applies its defaults.
const RANGES = new Set(['YTD', '1Y', '2Y', '5Y', '10Y', 'ALL']);
const CHART_TYPES = new Set(['line', 'bar']);
const SCALES = new Set(['absolute', 'indexed']);

// Is the indexed (rebase-to-100) scale meaningful for this fundamental? Rebasing
// is value / baseline * 100, which is only valid for a strictly-positive series:
// a fundamental that crosses/touches zero (Net Income / Operating Income loss
// years, a negative Earnings Yield) would vanish (<=0 baseline -> all-null) or
// invert (a -5M -> +10M rise plotting as -200). Mirrors the SPA's indexedMeaningful
// gate (CompanyCompare.jsx) so the tool never echoes scale=indexed into a URL/image
// the app would silently fall back from. Checks the FULL metric series (the tool's
// default range is ALL); a metric positive over the full history is positive in any
// sub-window, and a metric negative anywhere is at least invalid for the ALL default.
// Price is always > 0, so a price-only overlay (no metric series) is always OK.
function indexedMeaningfulForMetric(metric) {
    const s = metric && Array.isArray(metric.series) ? metric.series : null;
    if (!s || !s.length) return true; // price-only / no fundamental points
    let sawFinite = false;
    for (const p of s) {
        const raw = Array.isArray(p) ? p[1] : (p && p.value);
        // Number(null) is 0 (would read as non-positive), so treat null/undefined as
        // an explicit gap, not a zero | honest gaps don't disqualify the series.
        if (raw == null) continue;
        const v = Number(raw);
        if (!Number.isFinite(v)) continue; // NaN gap -> skip
        sawFinite = true;
        if (v <= 0) return false;
    }
    return sawFinite;
}

// The image endpoint lazy-renders the chrome-stripped chart (Puppeteer) on the
// first request for a (params + day) combo, so the first call pays a few seconds.
// Bound the fetch so the tool never hangs past an MCP client timeout | on timeout
// the image is omitted and image_url stays in the payload (it renders on first open).
const IMAGE_TIMEOUT_MS = 22000;

// Fetch a rendered PNG and return it as an MCP image block ({data: base64,
// mimeType}), or null on timeout / non-image / error.
async function fetchImageBounded(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const r = await fetch(url, { signal: ctrl.signal });
        if (!r.ok) return null;
        const ct = (r.headers.get('content-type') || '').split(';')[0];
        if (!ct.includes('image')) return null;
        const buf = Buffer.from(await r.arrayBuffer());
        if (!buf.length) return null;
        return { data: buf.toString('base64'), mimeType: ct || 'image/png' };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// Curator gate for admin-scoped MCP tools. The OAuth Bearer identity flows in
// via AsyncLocalStorage (tools-common.als, set by handleToolCall from
// req.mcpUser). We compare the authenticated email to CURATOR_EMAIL | no curator
// identity ⇒ the tool is invisible/unusable to anonymous + non-curator callers.
function isCuratorCaller() {
    const email = als.getStore()?.user?.email;
    const curator = process.env.CURATOR_EMAIL;
    return !!email && !!curator && email.toLowerCase().trim() === curator.toLowerCase().trim();
}

async function handleAppTool(name, args) {
    if (name === 'get_traction_overview') {
        if (!isCuratorCaller()) {
            return {
                content: [{ type: 'text', text: 'get_traction_overview is restricted to the autario curator. Authorize the connector via OAuth as the curator account to use it.' }],
                isError: true,
            };
        }
        // In-process read of the SAME aggregator the /api/admin/overview endpoint
        // serves (dashboardCache-backed, O(1)). The require sits outside the npm
        // tarball, so in the stdio package it must fail gracefully, not crash.
        let tractionOverview;
        try { tractionOverview = require('../services/tractionOverview'); } catch {
            return { content: [{ type: 'text', text: 'get_traction_overview needs the autario backend and is not available in the npm stdio package. Use the remote connector at https://autario.com/mcp instead.' }], isError: true };
        }
        const data = await tractionOverview.getOverview();
        return { content: [{ type: 'text', text: ser(data, args.format) }] };
    }

    // The engine report already existed as GET /api/v1/agent/engine-report, but
    // only behind an api-key/secret curl | so reading it meant leaving the tool
    // loop (Niko 2026-08-07: "kannst du die zahlen maschinenlesbar via MCP
    // pullen? das ist das wichtigste"). Same in-process read as the traction
    // tool above: one aggregator, two doors, no second implementation.
    if (name === 'get_engine_report') {
        if (!isCuratorCaller()) {
            return {
                content: [{ type: 'text', text: 'get_engine_report is restricted to the autario curator. Authorize the connector via OAuth as the curator account to use it.' }],
                isError: true,
            };
        }
        let agentReport;
        try { agentReport = require('../controllers/agentReportController'); } catch {
            return { content: [{ type: 'text', text: 'get_engine_report needs the autario backend and is not available in the npm stdio package. Use the remote connector at https://autario.com/mcp instead.' }], isError: true };
        }
        const out = { report: await agentReport.computeEngineReportSnapshot() };
        if (args.trends === true) {
            const days = Math.min(Math.max(Number(args.trend_days) || 30, 1), 90);
            out.trends = await agentReport.computeEngineTrendsSnapshot(days);
        }
        return { content: [{ type: 'text', text: ser(out, args.format) }] };
    }

    if (name === 'list_apps') {
        // ?mine=true is a no-op for unauthenticated callers (server ignores it),
        // and adds connected=true/false when the caller's auth flows through.
        const res = await fetch(`${API_BASE}/api/v1/public/apps?mine=true`, { headers: authHeaders() });
        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            throw new Error(`apps listing failed (${res.status}): ${txt.slice(0, 200)}`);
        }
        const data = await res.json();
        const apps = (Array.isArray(data.apps) ? data.apps : []).map(a => ({
            id: a.id,
            name: a.name,
            tagline: a.tagline || null,
            // The SHELF this app sits on (spec 2026-09-20-shelf-taxonomy): one
            // registry for connectors and apps, so `shelf` here is the same
            // vocabulary list_connectors answers with. `category` keeps the
            // human label for one release.
            shelf: a.shelf || null,
            shelf_label: a.shelf_label || null,
            category: a.category || null,
            // 'private' = works on the caller's own connected data, 'public' =
            // public datasets only (server-derived from the app manifest).
            data_scope: a.data_scope || null,
            url: a.route ? `${API_BASE}${a.route}` : null,
            ...(a.connected !== undefined ? { connected: a.connected } : {}),
        }));
        // THE USER'S apps first: connected (their data is behind it) before the
        // rest of the catalog, original catalog order within each group.
        apps.sort((a, b) => (b.connected === true) - (a.connected === true));
        const out = {
            count: apps.length,
            apps,
            note: 'Apps with connected=true have YOUR data behind them (listed first). Call get_app_context(app_id) for one app to see its manifest, KPI catalog (agent_surface: which MCP tool returns its computed report) and YOUR connected tables and artifacts.',
        };
        return { content: [{ type: 'text', text: ser(out, args.format) }] };
    }

    if (name === 'get_app_context') {
        const appId = String(args.app_id || '').trim().toLowerCase();
        if (!appId) throw new Error('app_id is required (get it from list_apps)');
        const res = await fetch(`${API_BASE}/api/v1/public/apps/${encodeURIComponent(appId)}/context`, { headers: authHeaders() });
        if (res.status === 404) {
            return { content: [{ type: 'text', text: `Unknown app id "${appId}". Call list_apps for the catalog of valid app ids.` }] };
        }
        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            throw new Error(`app context failed (${res.status}): ${txt.slice(0, 200)}`);
        }
        const ctx = await res.json();
        const out = compactAppContext(ctx, API_BASE);
        const footer = out.authenticated
            ? '\n\nIf agent_surface names an mcp_tool, call THAT first for the app\'s computed KPIs (what the user sees). For drill-downs query a table via its dataset_id: query_dataset(dataset_id) with fields/filter/aggregate (see query_examples), never whole tables. All reads are your own data; credentials are never exposed.'
            : '\n\nThis is the public manifest view. Authenticate (AUTARIO_API_KEY + AUTARIO_API_SECRET env vars, or OAuth at https://autario.com/mcp) to also see your own connected tables and artifacts.';
        return { content: [{ type: 'text', text: ser(out, args.format) + footer }] };
    }

    if (name === 'get_my_workspace') {
        const res = await fetch(`${API_BASE}/api/v1/public/apps/my/workspace`, { headers: authHeaders() });
        if (res.status === 401) {
            return { content: [{ type: 'text', text: 'get_my_workspace needs an authenticated caller. Set AUTARIO_API_KEY + AUTARIO_API_SECRET (stdio) or authorize via OAuth at https://autario.com/mcp, then call again.' }] };
        }
        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            throw new Error(`workspace fetch failed (${res.status}): ${txt.slice(0, 200)}`);
        }
        const ws = await res.json();
        const out = compactWorkspace(ws, API_BASE);
        const footer = out.my_apps
            ? '\n\nThese are the apps + datasets + saved views behind THIS user\'s account. Ground every app-related answer here: get_app_artifact(app, slug) for an exact saved view, query_dataset(dataset_id) for rows, get_app_context(app) for column lists.'
            : '\n\nNo apps in use yet. Suggest the catalog (list_apps) | activating an app or connecting a data source at https://autario.com/account makes it appear here.';
        return { content: [{ type: 'text', text: ser(out, args.format) + footer }] };
    }

    if (name === 'get_app_artifact') {
        const appId = String(args.app_id || '').trim().toLowerCase();
        const slug = String(args.slug || '').trim();
        if (!appId || !slug) throw new Error('app_id and slug are required (get them from get_app_context / get_my_workspace)');
        const res = await fetch(
            `${API_BASE}/api/v1/public/apps/${encodeURIComponent(appId)}/artifacts/${encodeURIComponent(slug)}`,
            { headers: authHeaders() }
        );
        if (res.status === 404) {
            return { content: [{ type: 'text', text: `No visible artifact "${slug}" in app "${appId}". Slugs come from get_app_context(app_id) -> your_artifacts. Private artifacts of other users are not accessible.` }] };
        }
        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            throw new Error(`artifact fetch failed (${res.status}): ${txt.slice(0, 200)}`);
        }
        const { artifact } = await res.json();
        const out = compactArtifact(artifact);
        const footer = out.truncated
            ? '\n\nParts of this artifact were truncated to fit the payload (marked inline; counts are real). For exact rows query the app\'s datasets (get_app_context -> query examples / query_dataset).'
            : '\n\nThis is the exact saved state of the artifact | interpret the user\'s view from spec (configuration) + data (inline values).';
        return { content: [{ type: 'text', text: ser(out, args.format) + footer }] };
    }

    if (name === 'audience_360') {
        // Own-data report: requires the CALLER's identity (OAuth Bearer or the
        // caller's own API keys). authHeaders() resolves that; an empty result
        // means an anonymous remote caller | tell them how to connect instead
        // of erroring.
        const headers = authHeaders();
        if (!Object.keys(headers).length) {
            return { content: [{ type: 'text', text: 'audience_360 reads YOUR OWN Search Console + GA4 data, so it needs your autario identity. Authorize via OAuth at https://autario.com/mcp, or set AUTARIO_API_KEY + AUTARIO_API_SECRET. Then connect the app at https://autario.com/apps/audience-360.' }] };
        }
        const qs = new URLSearchParams();
        if (args.range) qs.set('range', String(args.range));
        if (args.from) qs.set('from', String(args.from));
        if (args.to) qs.set('to', String(args.to));
        if (args.channel) qs.set('channel', String(args.channel));
        if (args.countries) qs.set('countries', String(args.countries));
        // The brand TERM under its own name since 2026-09-22. `brand` is the
        // grouping now, and the server reads it as the grouping only when it
        // is a uuid, so both spellings stay unambiguous on the wire.
        if (args.brand_term) qs.set('brand_term', String(args.brand_term));
        setScope(qs, args);
        const res = await fetch(`${API_BASE}/api/v1/public/audience/report${qs.toString() ? '?' + qs.toString() : ''}`, { headers });
        if (res.status === 401) {
            return { content: [{ type: 'text', text: 'Your autario credentials were not accepted. Re-authorize via OAuth at https://autario.com/mcp (or check AUTARIO_API_KEY + AUTARIO_API_SECRET).' }] };
        }
        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            throw new Error(`audience report failed (${res.status}): ${txt.slice(0, 200)}`);
        }
        const report = await res.json();
        const out = compactAudienceReport(report, args.sections);
        const notConnected = out.connected && !Object.values(out.connected).some(Boolean);
        const footer = notConnected
            ? '\n\nNo data connection found on this account yet (Search Console, GA4, Facebook Page, Instagram or TikTok). The user connects Google sources at https://autario.com/apps/audience-360 and social sources at https://autario.com/connectors.'
            : '\n\nAll numbers are computed deterministically from the caller\'s own connector data (the exact numbers the Audience 360 app shows). Truncated lists carry an *_omitted count; call again with other `sections` for more, or drill down with query_dataset on the dataset_ids from get_app_context("audience-360"). Full app: https://autario.com/apps/audience-360';
        return { content: [{ type: 'text', text: ser(out, args.format) + footer }] };
    }

    if (name === 'seo_360') {
        // Own-data report: requires the CALLER's identity (OAuth Bearer or the
        // caller's own API keys), same contract as audience_360.
        const headers = authHeaders();
        if (!Object.keys(headers).length) {
            return { content: [{ type: 'text', text: 'seo_360 reads YOUR OWN Search Console data, so it needs your autario identity. Authorize via OAuth at https://autario.com/mcp, or set AUTARIO_API_KEY + AUTARIO_API_SECRET. Then connect Search Console at https://autario.com/apps/seo-360.' }] };
        }
        const qs = new URLSearchParams();
        if (args.days != null) qs.set('days', String(args.days));
        setScope(qs, args);
        const res = await fetch(`${API_BASE}/api/v1/apps/seo-360/report${qs.toString() ? '?' + qs.toString() : ''}`, { headers });
        if (res.status === 401) {
            return { content: [{ type: 'text', text: 'Your autario credentials were not accepted. Re-authorize via OAuth at https://autario.com/mcp (or check AUTARIO_API_KEY + AUTARIO_API_SECRET).' }] };
        }
        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            throw new Error(`seo report failed (${res.status}): ${txt.slice(0, 200)}`);
        }
        const report = await res.json();
        const out = compactSeoReport(report, args.sections);
        const footer = out.connected === false
            ? '\n\nNo Search Console connection found on this account yet. The user connects it at https://autario.com/apps/seo-360 (one read-only Google sign-in).'
            : '\n\nAll numbers are computed deterministically from the caller\'s own Search Console connector data; every row carries the recommended action. Truncated lists carry a *_omitted count; call again with other `sections` for more. When the user wants the visual report, link https://autario.com/apps/seo-360/report';
        return { content: [{ type: 'text', text: ser(out, args.format) + footer }] };
    }

    if (name === 'marketing_report') {
        // Own-data report: requires the CALLER's identity (OAuth Bearer or the
        // caller's own API keys), same contract as social_360 / seo_360. A thin
        // wrapper over the public REST route, so the tool and the page can never
        // disagree about a number.
        const headers = authHeaders();
        if (!Object.keys(headers).length) {
            return { content: [{ type: 'text', text: 'marketing_report reads YOUR OWN connected ad and shop accounts, so it needs your autario identity. Authorize via OAuth at https://autario.com/mcp, or set AUTARIO_API_KEY + AUTARIO_API_SECRET. Then connect an ad or shop account at https://autario.com/connectors.' }] };
        }
        const qs = new URLSearchParams();
        // `brand` is the word; `client` is what a caller written against the
        // 20.09. tool still sends, and both mean the same id.
        setScope(qs, { brand: args.brand || args.client, instances: args.instances });
        if (args.period) qs.set('period', String(args.period));
        if (args.from) qs.set('from', String(args.from));
        if (args.to) qs.set('to', String(args.to));
        const res = await fetch(`${API_BASE}/api/v1/apps/marketing-report/report${qs.toString() ? '?' + qs.toString() : ''}`, { headers });
        if (res.status === 401) {
            return { content: [{ type: 'text', text: 'Your autario credentials were not accepted. Re-authorize via OAuth at https://autario.com/mcp (or check AUTARIO_API_KEY + AUTARIO_API_SECRET).' }] };
        }
        if (res.status === 404) {
            return { content: [{ type: 'text', text: 'That brand does not belong to this account. Call marketing_report without `brand` to see the brands this account holds, then pass one of their ids.' }] };
        }
        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            throw new Error(`marketing report failed (${res.status}): ${txt.slice(0, 200)}`);
        }
        const report = await res.json();
        const out = compactMarketingReport(report, args.sections);
        const footer = out.state && out.state !== 'ok'
            ? '\n\nThere is no report for this brand yet, and the `state` field says which of the four reasons applies. Read `headline` and `next_step` to the user rather than reporting zeros: none of these states means the numbers are zero.'
            : '\n\nAll numbers are computed deterministically from the caller\'s own derived marketing table, under ONE definition of every ratio (printed in `definitions`). Money is NEVER converted between currencies: a null money figure with a `reason` means the window holds more than one currency, and `totals_by_currency` is the answer instead. Conversions are what each ad platform reported under its own attribution setting and are never de-duplicated across channels, so do not add shop revenue and analytics revenue together. A day nobody reported is absent from `daily` rather than a zero. Call again with other `sections` for more. When the user wants the visual report, link https://autario.com/apps/marketing-report/overview';
        return { content: [{ type: 'text', text: ser(out, args.format) + footer }] };
    }

    if (name === 'projects') {
        // Own-data tool, read AND write, and a THIN wrapper over the same REST
        // routes the page calls: the tool and the board can never disagree
        // about which card sits in which column, because neither of them
        // computes that | services/projectsReport does, once.
        const headers = authHeaders();
        if (!Object.keys(headers).length) {
            return { content: [{ type: 'text', text: 'projects reads and writes YOUR OWN project board, so it needs your autario identity. Authorize via OAuth at https://autario.com/mcp, or set AUTARIO_API_KEY + AUTARIO_API_SECRET.' }] };
        }
        const action = String(args.action || 'list');
        const base = `${API_BASE}/api/apps/projects`;
        const jsonHeaders = { 'Content-Type': 'application/json', ...headers };

        // The writable fields per kind, named ONCE. A field the tool schema
        // does not declare cannot reach the API through here.
        const FIELDS = {
            project: ['title', 'brief', 'kind', 'stage', 'owner', 'contributors', 'country',
                'function', 'resources_url', 'status', 'progress_pct', 'key_result_id',
                'started_at', 'target_date', 'parent_id', 'budget_amount', 'budget_currency',
                'spent_amount', 'effort_days', 'impact'],
            objective: ['title', 'owner', 'commitment', 'starts_on', 'ends_on', 'parent_id'],
            key_result: ['title', 'owner', 'unit', 'baseline', 'target', 'target_reason', 'direction',
                'manual_value', 'dataset_id', 'value_column', 'filter_column', 'filter_value',
                'guards_id', 'guardrail_note', 'aggregation', 'country_values', 'country_column'],
        };
        const bodyOf = (kind = 'project') => {
            const out = {};
            for (const k of FIELDS[kind]) {
                if (args[k] !== undefined) out[k] = args[k];
            }
            return out;
        };
        const needs = (field, what) => ({ content: [{ type: 'text', text: `projects action "${action}" needs \`${field}\`. ${what}` }] });

        let res;
        if (action === 'list') {
            const qp = new URLSearchParams();
            if (args.group) qp.set('group', String(args.group));
            if (args.sort) qp.set('sort', String(args.sort));
            const qs = qp.toString() ? `?${qp}` : '';
            res = await fetch(`${base}${qs}`, { headers });
        } else if (action === 'get') {
            if (!args.id) return { content: [{ type: 'text', text: 'projects action "get" needs `id`. Call it with action "list" first to see the board and its project ids.' }] };
            res = await fetch(`${base}/${encodeURIComponent(String(args.id))}`, { headers });
        } else if (action === 'create') {
            if (!args.title) return { content: [{ type: 'text', text: 'projects action "create" needs `title`. Everything else is optional: a new project starts running, or waits in the inbox for an admin when the board asks for approval.' }] };
            res = await fetch(base, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(bodyOf()) });
        } else if (action === 'update') {
            if (!args.id) return { content: [{ type: 'text', text: 'projects action "update" needs `id`. Call it with action "list" first to see the board and its project ids.' }] };
            res = await fetch(`${base}/${encodeURIComponent(String(args.id))}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(bodyOf()) });
        } else if (action === 'objectives') {
            res = await fetch(`${base}/objectives`, { headers });
        } else if (action === 'create_objective') {
            if (!args.title) return needs('title', 'An objective is qualitative: what you want to achieve, in words.');
            res = await fetch(`${base}/objectives`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(bodyOf('objective')) });
        } else if (action === 'update_objective') {
            if (!args.id) return needs('id', 'Call it with action "objectives" first to see the objective ids.');
            res = await fetch(`${base}/objectives/${encodeURIComponent(String(args.id))}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(bodyOf('objective')) });
        } else if (action === 'create_key_result') {
            if (!args.objective_id) return needs('objective_id', 'Call it with action "objectives" first to see the objective ids.');
            // With values per country the target is derived from them.
            const derived = Array.isArray(args.country_values) && args.country_values.length > 0;
            if (!args.title || (args.target === undefined && !derived)) return needs(!args.title ? 'title' : 'target', 'A key result is a number with a target.');
            res = await fetch(`${base}/objectives/${encodeURIComponent(String(args.objective_id))}/key-results`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(bodyOf('key_result')) });
        } else if (action === 'update_key_result') {
            if (!args.id) return needs('id', 'Call it with action "objectives" first to see the key result ids.');
            res = await fetch(`${base}/key-results/${encodeURIComponent(String(args.id))}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(bodyOf('key_result')) });
        } else {
            return { content: [{ type: 'text', text: `projects does not know the action "${action}". Use list, get, create, update, objectives, create_objective, update_objective, create_key_result or update_key_result.` }] };
        }

        if (res.status === 401) {
            return { content: [{ type: 'text', text: 'Your autario credentials were not accepted. Re-authorize via OAuth at https://autario.com/mcp (or check AUTARIO_API_KEY + AUTARIO_API_SECRET).' }] };
        }
        if (res.status === 403) {
            const body = await res.json().catch(() => null);
            return { content: [{ type: 'text', text: (body && body.error) || 'This account may read that board but not change it.' }] };
        }
        if (res.status === 404) {
            return { content: [{ type: 'text', text: 'Nothing with that id on this account. Call projects with action "list" (projects) or "objectives" (objectives and key results) to see the ids.' }] };
        }
        if (!res.ok) {
            const body = await res.json().catch(() => null);
            if (body && body.error) return { content: [{ type: 'text', text: body.error }] };
            throw new Error(`projects failed (${res.status})`);
        }
        const payload = await res.json();
        const out = compactProjects(action, payload);
        const footer = action === 'list'
            ? '\n\nEvery card is one project of this account. `inbox` holds the ones nobody has decided on yet, `groups` holds the rest folded on `group_by`, and a group with key null is the named "nothing set on this axis" group rather than a missing row. A KPI value of null carries a `reason` from `kpi_reasons` and never means zero. `key_results` lists what a project can be linked to; action "objectives" shows them with their status.'
            : action === 'objectives'
                ? '\n\nEvery status is derived from the value, the target and the time window, never set by hand; `unknown` means no value yet and is never on track. `source` says whether a value was read from a dataset or typed by hand.'
                : '\n\nProgress and the traffic light of a PROJECT are set by a person, not derived, so they say what somebody asserted. A KPI or key result reads its number either from a typed value or live from a dataset column on this account, never both.';
        return { content: [{ type: 'text', text: ser(out, args.format) + footer }] };
    }

    if (name === 'social_360') {
        // Own-data report: requires the CALLER's identity (OAuth Bearer or the
        // caller's own API keys), same contract as audience_360 / seo_360.
        const headers = authHeaders();
        if (!Object.keys(headers).length) {
            return { content: [{ type: 'text', text: 'social_360 reads YOUR OWN Facebook, Instagram, TikTok, YouTube and LinkedIn data, so it needs your autario identity. Authorize via OAuth at https://autario.com/mcp, or set AUTARIO_API_KEY + AUTARIO_API_SECRET. Then connect a social account at https://autario.com/connectors.' }] };
        }
        const qs = new URLSearchParams();
        if (args.days != null) qs.set('days', String(args.days));
        if (args.sort) qs.set('sort', String(args.sort));
        setScope(qs, args);
        const res = await fetch(`${API_BASE}/api/v1/apps/social-360/report${qs.toString() ? '?' + qs.toString() : ''}`, { headers });
        if (res.status === 401) {
            return { content: [{ type: 'text', text: 'Your autario credentials were not accepted. Re-authorize via OAuth at https://autario.com/mcp (or check AUTARIO_API_KEY + AUTARIO_API_SECRET).' }] };
        }
        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            throw new Error(`social report failed (${res.status}): ${txt.slice(0, 200)}`);
        }
        const report = await res.json();
        const out = compactSocialReport(report, args.sections);
        const footer = out.any_connected === false
            ? '\n\nNo social account is connected on this account yet. The user connects Facebook, Instagram, TikTok, YouTube or LinkedIn at https://autario.com/connectors; one platform is enough to start.'
            : '\n\nAll numbers are computed deterministically from the caller\'s own social connector data. The score is an index against the account\'s own history, not an industry benchmark, and spike candidates are candidates, not proven causes. Truncated lists carry a *_omitted count; call again with other `sections` for more. When the user wants the visual report, link https://autario.com/apps/social-360/report';
        return { content: [{ type: 'text', text: ser(out, args.format) + footer }] };
    }

    if (name === 'ai_visibility_360') {
        // Own-data report: requires the CALLER's identity (OAuth Bearer or the
        // caller's own API keys), same contract as the other 360 tools. Reads
        // ONLY: every endpoint below is owner-scoped server-side, and no write
        // path (run start, prompt edit, settings) is reachable from here.
        const headers = authHeaders();
        if (!Object.keys(headers).length) {
            return { content: [{ type: 'text', text: 'ai_visibility_360 reads YOUR OWN brand visibility data, so it needs your autario identity. Authorize via OAuth at https://autario.com/mcp, or set AUTARIO_API_KEY + AUTARIO_API_SECRET. Then set a brand up at https://autario.com/apps/ai-visibility.' }] };
        }
        const bRes = await fetch(`${API_BASE}/api/visibility/brands`, { headers });
        if (bRes.status === 401) {
            return { content: [{ type: 'text', text: 'Your autario credentials were not accepted. Re-authorize via OAuth at https://autario.com/mcp (or check AUTARIO_API_KEY + AUTARIO_API_SECRET).' }] };
        }
        if (!bRes.ok) {
            const txt = await bRes.text().catch(() => '');
            throw new Error(`brand listing failed (${bRes.status}): ${txt.slice(0, 200)}`);
        }
        const brands = await bRes.json();
        const list = Array.isArray(brands) ? brands : [];
        if (!list.length) {
            return { content: [{ type: 'text', text: 'No AI Visibility brand is set up on this account yet. The user creates one (brand terms, competitors, prompts) at https://autario.com/apps/ai-visibility/setup; after the first run this tool returns the report.' }] };
        }
        // Brand resolution: explicit arg by id or exact name (case-insensitive);
        // one brand = that brand; several without an arg = list them, pick
        // nothing (multi-client accounts: a wrong default is worse than a
        // follow-up question).
        const want = String(args.brand || '').trim().toLowerCase();
        let brand = null;
        if (want) {
            brand = list.find(b => String(b.id || '').toLowerCase() === want
                || String(b.name || '').trim().toLowerCase() === want) || null;
            if (!brand) {
                return { content: [{ type: 'text', text: `No brand "${args.brand}" on this account. Its brands: ${list.map(b => b.name).join(', ')}. Re-call with one of these as \`brand\`.` }] };
            }
        } else if (list.length === 1) {
            brand = list[0];
        } else {
            return { content: [{ type: 'text', text: `This account has ${list.length} brands: ${list.map(b => b.name).join(', ')}. Re-call with \`brand\` set to one of them; nothing is picked for you (their numbers must never mix).` }] };
        }

        const wanted = sanitizeVisSections(args.sections);
        const days = args.days != null ? Math.max(1, Math.min(365, Number(args.days) || 30)) : null;
        const dq = days != null ? `days=${days}` : '';
        const get = async (path) => {
            const res = await fetch(`${API_BASE}${path}`, { headers });
            if (!res.ok) {
                const txt = await res.text().catch(() => '');
                throw new Error(`visibility read failed (${res.status} on ${path.split('?')[0]}): ${txt.slice(0, 200)}`);
            }
            return res.json();
        };
        const bid = encodeURIComponent(brand.id);

        // ONE /report read serves overview + prompts + sources; the other
        // sections have their own endpoints. Fetched sequentially and only on
        // demand (token + load discipline).
        let out;
        if (wanted.some(s => ['overview', 'prompts', 'sources', 'model_rankings'].includes(s))) {
            const report = await get(`/api/visibility/brands/${bid}/report${dq ? '?' + dq : ''}`);
            out = compactVisibilityReport(report, wanted);
            // spec 2026-09-12-vis-peec-gaps-p0 gap 16: derived from the SAME
            // report read, never a second request.
            if (wanted.includes('model_rankings')) out.model_rankings = compactVisibilityModelRankings(report);
        } else {
            out = {
                app: 'AI Visibility 360', brand: brand.name || null,
                sections_returned: wanted, sections_available: VIS_SECTIONS,
            };
        }
        if (wanted.includes('actions')) {
            const sep = dq ? '&' + dq : '';
            const owned = await get(`/api/visibility/brands/${bid}/actions?bucket=owned${sep}`);
            const earned = await get(`/api/visibility/brands/${bid}/actions?bucket=earned${sep}`);
            out.actions = compactVisibilityActions(owned, earned);
            out.population = out.population || compactVisPopulation(owned) || compactVisPopulation(earned);
        }
        if (wanted.includes('answers')) {
            const sep = dq ? '&' + dq : '';
            out.answers = compactVisibilityAnswers(
                await get(`/api/visibility/answers?brand_id=${bid}&limit=${VIS_MAX_ANSWERS}${sep}`)
            );
        }
        if (wanted.includes('impact')) {
            out.impact = compactVisibilityImpact(
                await get(`/api/visibility/brands/${bid}/impact${dq ? '?' + dq : ''}`)
            );
        }
        // spec 2026-09-05 blocks: searches + movers ride on ONE sources read
        if (wanted.includes('searches') || wanted.includes('movers')) {
            const src = await get(`/api/visibility/brands/${bid}/sources${dq ? '?' + dq : ''}`);
            if (wanted.includes('searches')) out.searches = compactVisibilitySearches(src);
            if (wanted.includes('movers')) out.movers = compactVisibilityMovers(src);
            out.population = out.population || compactVisPopulation(src);
        }
        if (wanted.includes('gaps')) {
            const gapsPayload = await get(`/api/visibility/brands/${bid}/sources?view=gaps${dq ? '&' + dq : ''}`);
            out.gaps = compactVisibilityGaps(gapsPayload);
            out.population = out.population || compactVisPopulation(gapsPayload);
        }
        if (wanted.includes('pages')) {
            const pagesPayload = await get(`/api/visibility/brands/${bid}/sources?view=urls${dq ? '&' + dq : ''}`);
            out.pages = compactVisibilityPages(pagesPayload);
            out.population = out.population || compactVisPopulation(pagesPayload);
        }
        if (wanted.includes('crawlability')) {
            out.crawlability = compactVisibilityCrawlability(await get(`/api/visibility/brands/${bid}/crawlability`));
        }
        if (wanted.includes('perception')) {
            const perceptionPayload = await get(`/api/visibility/brands/${bid}/perception${dq ? '?' + dq : ''}`);
            out.perception = compactVisibilityPerception(perceptionPayload);
            out.population = out.population || compactVisPopulation(perceptionPayload);
        }
        if (wanted.includes('action_effects')) {
            const effectsPayload = await get(`/api/visibility/brands/${bid}/actions/impact`);
            out.action_effects = compactVisibilityActionEffects(effectsPayload);
            out.population = out.population || compactVisPopulation(effectsPayload);
        }

        const footer = '\n\nAll numbers are read deterministically from this brand\'s stored runs (the exact numbers the app shows); no LLM ran for this read and no run was started. A null metric means the window has no data for it, never zero. Truncated lists carry a *_omitted count; call again with other `sections` for more. Recipe for a custom report: interpret these numbers yourself citing them, and to deliver charts write your derived rows with create_dataset + write_rows, then create_chart_from_spec. Full app: https://autario.com/apps/ai-visibility/report';
        return { content: [{ type: 'text', text: ser(out, args.format) + footer }] };
    }

    if (name === 'bubble_or_not') {
        const ticker = String(args.ticker || '').toUpperCase().trim();
        if (!ticker) throw new Error('ticker is required');
        const base = `${API_BASE}/api/v1/public/company-compare`;
        const enc = encodeURIComponent(ticker);

        // 1. Available metrics + company name. Unknown ticker -> 404; try one
        //    on-demand live ingest (Yahoo price + SEC fundamentals, gated by the
        //    same quality checks as catalog grow), then retry once.
        const getMetrics = () => fetch(`${base}/${enc}/metrics`);
        let mRes = await getMetrics();
        if (mRes.status === 404) {
            // Cold ticker | not in the catalog yet. Live-fetch it once within THIS
            // call (time-bounded, see postEnsureBounded) so the LLM gets one clean
            // answer after a short wait instead of two round-trips.
            const ens = await postEnsureBounded(`${base}/${enc}/ensure`, ENSURE_TIMEOUT_MS);
            if (ens && ens.status === 'invalid') {
                return { content: [{ type: 'text', text: `"${ticker}" is not a known or valid US stock ticker on autario. Try a different symbol (e.g. AAPL, MSFT, NVDA, TSLA).` }] };
            }
            mRes = await getMetrics();
        }
        if (mRes.status === 404) {
            // ensure hit its time bound before the data materialized. Stay one call,
            // don't hang | tell the model to retry in a moment (the fetch finishes
            // server-side, so the next call is instant).
            return { content: [{ type: 'text', text: `${ticker} is being fetched live (market price + SEC filings) and isn't ready yet. Call bubble_or_not again for ${ticker} in a few seconds.` }] };
        }
        if (!mRes.ok) {
            const txt = await mRes.text().catch(() => '');
            throw new Error(`metrics lookup failed (${mRes.status}): ${txt.slice(0, 200)}`);
        }
        const meta = await mRes.json();
        const available = Array.isArray(meta.metrics) ? meta.metrics : [];

        // 2. Choose the fundamental to overlay. Explicit arg wins (matched against
        //    label or id, case-insensitive); else first available; else null
        //    (price-only company).
        let metricLabel = null;
        if (args.metric && String(args.metric).trim()) {
            const want = String(args.metric).trim().toLowerCase();
            const hit = available.find(m =>
                String(m.label || '').toLowerCase() === want ||
                String(m.id || '').toLowerCase() === want);
            metricLabel = hit ? (hit.label || hit.id) : String(args.metric).trim();
        } else {
            const firstOk = available.find(m => m.available !== false) || available[0];
            metricLabel = firstOk ? (firstOk.label || firstOk.id) : null;
        }

        // 3. Price + fundamental series + deterministic verdict (insight).
        const q = metricLabel ? `?metric=${encodeURIComponent(metricLabel)}` : '';
        const sRes = await fetch(`${base}/${enc}${q}`);
        if (!sRes.ok) {
            const txt = await sRes.text().catch(() => '');
            throw new Error(`compare lookup failed (${sRes.status}): ${txt.slice(0, 200)}`);
        }
        const series = await sRes.json();

        // 4. Normalize the view params (drop anything the SPA wouldn't understand)
        //    and build ONE query string that both the clickable link and the image
        //    render share, so they always show the identical view.
        const range = RANGES.has(String(args.range || '').toUpperCase())
            ? String(args.range).toUpperCase() : null;
        const chartType = CHART_TYPES.has(String(args.chart_type || '').toLowerCase())
            ? String(args.chart_type).toLowerCase() : null;
        let scale = SCALES.has(String(args.scale || '').toLowerCase())
            ? String(args.scale).toLowerCase() : null;

        // DATA SACRED: indexed (rebase-to-100) is meaningless for a fundamental that
        // crosses zero (Net Income / Operating Income loss years, a negative Earnings
        // Yield) | it would invert or vanish. If the model asked for scale=indexed on
        // such a metric, downgrade to absolute (the dual-axis view shows the real
        // movement) and surface a clear note, so the URL/image we hand back match the
        // app (which falls back to absolute for the same reason) and the model knows
        // why. Mirrors the SPA's indexedMeaningful gate (no inverted indexed line ever).
        let indexedDowngraded = false;
        if (scale === 'indexed' && !indexedMeaningfulForMetric(series.metric)) {
            scale = 'absolute';
            indexedDowngraded = true;
        }

        const viewQs = new URLSearchParams();
        if (metricLabel) viewQs.set('metric', metricLabel);
        if (range) viewQs.set('range', range);
        if (chartType) viewQs.set('type', chartType);
        if (scale) viewQs.set('scale', scale);
        const qsStr = viewQs.toString();
        const sep = qsStr ? '?' : '';
        const tl = ticker.toLowerCase();

        const view_url  = `${API_BASE}/apps/bubble-or-not/${tl}${sep}${qsStr}`;          // clickable, full app
        const image_url = `${base}/${enc}/image${sep}${qsStr}`;                          // standalone PNG (lazy)
        const embed_code = `<iframe src="${API_BASE}/apps/bubble-or-not/${tl}?capture=1${qsStr ? '&' + qsStr : ''}" width="800" height="520" frameborder="0"></iframe>`;

        // 5. Compact, LLM-native payload | the verdict + key numbers, NOT the full
        //    daily series (that lives, verifiable, behind view_url).
        // price.points[i] = { date, close, ... }; metric.points[i] = { date, value, ... }.
        const priceLatest = latestPoint(series.price?.points);
        const metricLatest = latestPoint(series.metric?.points);

        // 6. Inline chart image of this exact view (bounded; graceful if it times out).
        const img = await fetchImageBounded(image_url, IMAGE_TIMEOUT_MS);

        // Multi-year valuation brief (companyInsight.valuationFacts, surfaced via
        // the public series endpoint as insight.facts.valuation). When present the
        // verdict is the 2-3 sentence brief (lead = the "is X overvalued" answer +
        // the story = peak/trough/decomposition/multi-window), and a compact
        // `valuation` block carries the citable numbers. Defensive: pre-deploy or a
        // metric without a valuation block falls back to insight.text (the YoY line).
        const val = series.insight?.facts?.valuation || null;
        const verdictText = val
            ? [val.lead, val.story].filter(Boolean).join(' ')
            : (series.insight?.text
                || (series.metric ? null : 'No SEC fundamentals available for this ticker | only the price history is shown.'));

        const out = {
            app: 'Bubble Or Not?',
            company: series.name || meta.name || ticker,
            ticker,
            overlay_metric: series.metric?.label || metricLabel || null,
            view: {
                range: range || 'ALL',
                chart_type: chartType || 'auto',
                scale: scale || 'absolute',
                // Present ONLY when an indexed request was downgraded | tells the
                // model the rebased view isn't available for this metric and why.
                ...(indexedDowngraded ? { indexed_unavailable: `Indexed (rebased-to-100) view is not available for ${series.metric?.label || metricLabel || 'this metric'} because the series crosses zero (negative values), which would invert the rebased line. Showing the absolute dual-axis view instead.` } : {}),
            },
            verdict: verdictText,
            // Compact, citable valuation summary (the multi-year answer). Omitted
            // when no valuation block (price-only / pre-deploy YoY-only metric).
            ...(val ? {
                valuation: {
                    metric: series.metric?.label || metricLabel,
                    current: val.latestValue, unit: val.unit, as_of: val.latestDate,
                    percentile: val.percentile, range: { low: val.min, high: val.max, median: val.median },
                    verdict: val.verdict, // cheap | fair | expensive (vs own history)
                    all_time_high: val.allTimeHigh, all_time_low: val.allTimeLow,
                    change: { '1y': val.change1y, '5y': val.change5y, full: val.changeFull },
                    ...(val.decomposition ? { decomposition: val.decomposition } : {}),
                },
            } : {}),
            facts: series.insight?.facts || null,
            latest_price: priceLatest ? { date: priceLatest.date, close: priceLatest.close } : null,
            latest_metric: metricLatest
                ? { date: metricLatest.date, value: metricLatest.value, unit: series.metric?.unit || null }
                : null,
            available_metrics: available.map(m => m.label || m.id).filter(Boolean),
            sources: (series.sources || []).filter(Boolean),
            view_url,
            image_url,
            image_inline: !!img,
            embed_code,
            ...(series.note || meta.note ? { note: series.note || meta.note } : {}),
        };

        const footer = '\n\nThe verdict and every number above are computed deterministically from real SEC filings + market data (no estimates, nothing invented). Always cite sources[]. '
            + (indexedDowngraded
                ? 'NOTE: you requested the indexed scale, but it is not available for this metric (the series crosses zero, so rebasing to 100 would invert the line); the absolute dual-axis view is shown instead. '
                : '')
            + (img
                ? 'The attached image is this exact overlay; open view_url for the live interactive version.'
                : 'image_url renders the chart on first open (it was still rendering); open view_url for the live interactive version.')
            + ' Call again with a different metric / range / chart_type / scale to change the view.';

        const content = [{ type: 'text', text: ser(out, args.format) + footer }];
        if (img) content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
        return { content };
    }

    const lifecycle = await handleAppLifecycleTool(name, args);
    if (lifecycle !== undefined) return lifecycle;

    return undefined;
}

// ─── App LIFECYCLE handlers (spec 2026-09-08-dai-b1-publish-door) ──────────
//
// Seven thin wrappers over the REST doors. They add exactly three things and
// nothing else: the app id goes into the PATH (never a body field a model could
// contradict), the response is serialized in the caller's format, and an
// absolute URL is built for anything the user is meant to click.
//
// They add NO permission logic. `callWriteAPI` sends the AsyncLocalStorage
// bearer (tools.js) and the server decides; a refusal (401, 402 plan limit, 403
// taken down, 404 not yours) comes back through formatWriteError as text the
// model can act on, including the machine-readable upsell fields of a 402.
function absoluteUrls(out) {
    if (!out || typeof out !== 'object') return out;
    const abs = { ...out };
    for (const k of ['preview_url', 'public_url']) {
        if (typeof abs[k] === 'string' && abs[k].startsWith('/')) abs[k] = `${API_BASE}${abs[k]}`;
    }
    return abs;
}

async function handleAppLifecycleTool(name, args) {
    const appId = String(args.app_id || '').trim();

    if (name === 'create_app') {
        const created = await callWriteAPI('POST', '/developer/apps', {
            name: args.name,
            tagline: args.tagline,
            entry_kind: args.entry_kind || (args.content ? 'upload' : 'url'),
            entry_url: args.entry_url,
            content: args.content,
            content_type: args.content_type,
            source_url: args.source_url,
            datasets: Array.isArray(args.datasets) ? args.datasets : undefined,
        });
        const manifest = created.manifest || {};
        // One extra call so the FIRST answer already carries the preview link and
        // the next step | a model that stops reading after the create response
        // still knows where to go.
        const view = manifest.id
            ? await callWriteAPI('GET', `/developer/apps/${encodeURIComponent(manifest.id)}/preview`).catch(() => null)
            : null;
        const out = {
            app_id: manifest.id,
            name: manifest.name,
            visibility: manifest.visibility,
            entry_url: manifest.entry_url,
            ...(view ? absoluteUrls(view) : {}),
            next_step: view?.next_step
                || 'Open the preview_url to try it, then publish with publish_app.',
        };
        return { content: [{ type: 'text', text: ser(out, args.format) }] };
    }

    if (name === 'update_app_manifest') {
        // PUT /manifest is a full REPLACE (the manifest IS the row), so a model
        // that sets one field would silently drop entry_url, version and the
        // declared datasets. Read the current manifest and MERGE, so the tool
        // behaves the way its name reads and a partial call cannot break an app.
        const current = await callWriteAPI('GET', `/developer/apps/${encodeURIComponent(appId)}`);
        const m = (current && current.manifest) || {};
        const body = {
            name: m.name, tier: m.tier || 2, tagline: m.tagline, entry_url: m.entry_url,
            version: m.version, source_url: m.source_url,
            consumed_datasets: m.consumed_datasets || [],
            share: m.share,
        };
        for (const f of ['name', 'tagline', 'entry_url', 'version', 'source_url', 'consumed_datasets', 'tier', 'share']) {
            if (args[f] !== undefined) body[f] = args[f];
        }
        const res = await callWriteAPI('PUT', `/developer/apps/${encodeURIComponent(appId)}/manifest`, body);
        const saved = res.manifest || {};
        const out = {
            app_id: saved.id, name: saved.name, tagline: saved.tagline, entry_url: saved.entry_url,
            version: saved.version, visibility: saved.visibility,
            consumed_datasets: saved.consumed_datasets || [],
            share: saved.share || null,
            next_step: 'Upload the code with upload_app_bundle, or call get_app_preview_url to try it.',
        };
        return { content: [{ type: 'text', text: ser(out, args.format) }] };
    }

    if (name === 'upload_app_bundle') {
        const meta = await callWriteAPI('POST', `/developer/apps/${encodeURIComponent(appId)}/bundle`, {
            content: args.content,
            content_type: args.content_type || 'text/html',
            version: args.version,
        });
        const out = {
            app_id: appId,
            version: meta.version || null,
            bytes: meta.size ?? null,
            sha256: meta.sha256 || null,
            next_step: 'Call get_app_preview_url to open it, then publish_app when it works.',
        };
        return { content: [{ type: 'text', text: ser(out, args.format) }] };
    }

    if (name === 'write_app_artifact') {
        const artifactId = String(args.artifact_id || '').trim();
        const payload = {};
        for (const f of ['type', 'title', 'spec', 'data', 'visibility']) {
            if (args[f] !== undefined) payload[f] = args[f];
        }
        const res = artifactId
            ? await callWriteAPI('PATCH', `/public/apps/${encodeURIComponent(appId)}/artifacts/${encodeURIComponent(artifactId)}`, payload)
            : await callWriteAPI('POST', `/public/apps/${encodeURIComponent(appId)}/artifacts`, payload);
        const out = {
            artifact_id: res.id, app_id: res.app_id, type: res.type, slug: res.slug,
            title: res.title, visibility: res.visibility,
            next_step: `Read it back any time with get_app_artifact(app_id: "${res.app_id}", slug: "${res.slug}").`,
        };
        return { content: [{ type: 'text', text: ser(out, args.format) }] };
    }

    if (name === 'get_app_preview_url') {
        const view = await callWriteAPI('GET', `/developer/apps/${encodeURIComponent(appId)}/preview`);
        return { content: [{ type: 'text', text: ser(absoluteUrls(view), args.format) }] };
    }

    if (name === 'publish_app' || name === 'unpublish_app') {
        const visibility = name === 'unpublish_app'
            ? 'private'
            : (args.visibility === 'unlisted' ? 'unlisted' : 'public');
        const view = await callWriteAPI(
            'PATCH', `/developer/apps/${encodeURIComponent(appId)}/visibility`, { visibility }
        );
        return { content: [{ type: 'text', text: ser(absoluteUrls(view), args.format) }] };
    }

    return undefined;
}

module.exports = {
    APP_TOOLS, handleAppTool, indexedMeaningfulForMetric,
    // app lifecycle (create -> manifest -> bundle/artifact -> preview -> publish)
    APP_LIFECYCLE_TOOL_ROUTES, handleAppLifecycleTool,
    // pure app-context shapers, exported for tests
    compactAppContext, flattenContextTables, flattenConsumed,
    compactArtifact, boundValue, ARTIFACT_CHAR_BUDGET, compactWorkspace,
    // pure audience-360 shapers, exported for tests
    compactAudienceReport, sanitizeAudSections, scalarRow, capHead, capTail,
    // pure seo-360 shapers, exported for tests
    compactSeoReport, sanitizeSeoSections,
    // pure social-360 shapers, exported for tests
    compactSocialReport, sanitizeSocialSections,
    compactMarketingReport, sanitizeMarketingSections, MARKETING_SECTIONS,
    // pure ai-visibility-360 shapers, exported for tests
    compactVisibilityReport, compactVisibilityActions, compactVisibilityAnswers,
    compactVisibilityImpact, sanitizeVisSections,
    compactVisibilitySearches, compactVisibilityMovers, compactVisibilityPages, compactVisibilityCrawlability, compactVisibilityPerception, compactVisibilityActionEffects,
    compactVisibilityGaps, compactVisibilityModelRankings,
};
