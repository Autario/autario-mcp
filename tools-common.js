// backend/mcp/tools-common.js
// OWNED BY Track A
// Shared MCP infra | used by tools-data.js + tools-viz.js (and the union in tools.js).
// Single AsyncLocalStorage instance so the per-request OAuth bearer context flows
// to every handler's API call regardless of which split file the handler lives in.

const fetch = globalThis.fetch || require('node-fetch');
// Shared minimal-response convention (full flag + series summary + downsample +
// token-cost warning). summarizeXY + downsample below are thin adapters over it
// so the chart compactor and the ontology/stats endpoints never drift on what a
// series summary is.
const { summarizeSeries, downsample, parseFull, fullSeriesNote } = require('./minimalResponse');

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

// ── get_chart compaction ────────────────────────────────────────────────────
// The /chart/:id API returns the WHOLE chart verbatim: plotly_spec.traces with
// literal x[]/y[] arrays + the full Plotly layout/styling, the raw `data` rows,
// and builder_state. For a multi-entity comparison (e.g. G7 × 35 years) that is
// MEGABYTES (~5.9M chars measured) | dumping it verbatim into an MCP text result
// blows up any LLM context window and the call fails.
//
// compactChart() turns that into a token-bounded summary an LLM can still cite
// from: title/insight/datasets + a PER-SERIES headline (first/latest/min/max/avg
// + point count), the time range, and a small downsampled sample per series |
// then points at view_url for the full interactive chart. Mirrors compactDataset
// in tools-data.js. Generic across single-series AND multi-entity charts.
//
// Hard char budget on the FINAL string: if still over after summarizing, drop the
// lowest-priority parts (samples first, then narration) and flag truncation |
// never throw, never fall back to the raw bomb.

const CHART_COMPACT_CHAR_BUDGET = 24000; // ~6-8k tokens; a few tens of KB ceiling
const SERIES_SAMPLE_POINTS = 8;          // downsampled points kept per series (budget-permitting)
const MAX_SERIES = 40;                    // cap series listed (a 200-country chart still bounds)

function num(v) {
    if (v == null || v === '') return NaN;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
}
function round(n) { return Number.isFinite(n) ? +n.toFixed(4) : null; }

// downsample is the shared even-thinning helper (keeps first+last), imported
// from utils/minimalResponse so chart compaction + ontology/stats agree.

// Build a {first,latest,min,max,avg,count} summary from parallel x[]/y[] arrays.
// Thin adapter over the shared summarizeSeries: it does the numeric parse,
// sort, min/max/avg + change derivation once; here we only re-key its t/v
// canonical shape back to the x/y shape compactChart consumes (and keep an
// {x,y} _pts for the sample + x-range below). Behavior-preserving — same
// numbers, same rounding (round == round4).
function summarizeXY(xs, ys) {
    const n = Math.min(xs?.length || 0, ys?.length || 0);
    const rows = [];
    for (let i = 0; i < n; i++) rows.push({ t: xs[i], v: ys[i] });
    // NOTE: summarizeSeries re-sorts by t-string. compactChart's x is already
    // time-ordered (trace order = time order), so the sort is a no-op for the
    // real call sites and only normalizes already-sorted input.
    const s = summarizeSeries(rows);
    if (!s) return null;
    return {
        first: { x: s.first.t, y: s.first.v },
        latest: { x: s.latest.t, y: s.latest.v },
        min: { x: s.min.t, y: s.min.v },
        max: { x: s.max.t, y: s.max.v },
        avg: s.avg,
        count: s.count,
        _pts: s._pts.map(p => ({ x: p.t, y: p.v })), // internal | sample + x-range
    };
}

// Normalize a precomputed trace_stats stat block (chartInsightVerify shape) into
// the same summary shape so output is uniform whether stats were precomputed or
// derived. Returns null when the block is unusable.
function summaryFromTraceStat(stats) {
    if (!stats || typeof stats !== 'object') return null;
    const s = stats.start, e = stats.end, pk = stats.peak, tr = stats.trough;
    if (!s && !e) return null;
    return {
        first: s ? { x: s.x, y: round(num(s.y)) } : null,
        latest: e ? { x: e.x, y: round(num(e.y)) } : null,
        min: tr ? { x: tr.x, y: round(num(tr.y)) } : null,
        max: pk ? { x: pk.x, y: round(num(pk.y)) } : null,
        avg: round(num(stats.avg)),
        count: Number.isFinite(stats.count) ? stats.count : null,
        value_kind: stats.value_kind || undefined,
    };
}

// Pull a trace's (x,y) pairs whether the trace carries literal x[]/y[] arrays
// (Builder/prebuilt) or x_col/y_col column refs against the chart's `data` rows
// (MCP/builder_spec). Horizontal bars store the value array in x | swap so y is
// always the value axis.
function traceXY(trace, rows) {
    if (!trace || typeof trace !== 'object') return { xs: [], ys: [] };
    const horiz = trace.orientation === 'h';
    if (Array.isArray(trace.x) || Array.isArray(trace.y)) {
        const xs = trace.x || [], ys = trace.y || [];
        return horiz ? { xs: ys, ys: xs } : { xs, ys };
    }
    // Column-ref shape: optionally filtered by group_by/group_value.
    const xCol = trace.x_col, yCol = trace.y_col;
    if (xCol && yCol && Array.isArray(rows)) {
        const gb = trace.group_by, gv = trace.group_value;
        const xs = [], ys = [];
        for (const r of rows) {
            if (!r) continue;
            if (gb != null && gv != null && String(r[gb]) !== String(gv)) continue;
            xs.push(r[xCol]); ys.push(r[yCol]);
        }
        return horiz ? { xs: ys, ys: xs } : { xs, ys };
    }
    return { xs: [], ys: [] };
}

// Derive per-series summaries from plotly_spec + raw data. Used when the chart
// has no precomputed trace_stats (legacy/MCP charts) | also supplies the x-range
// + sample points which trace_stats alone doesn't carry.
function deriveSeries(plotlySpec, rows) {
    const traces = Array.isArray(plotlySpec?.traces) ? plotlySpec.traces : [];
    const out = [];
    for (const t of traces.slice(0, MAX_SERIES)) {
        const { xs, ys } = traceXY(t, rows);
        const summary = summarizeXY(xs, ys);
        const name = t?.name || t?.group_value || t?.legendgroup || null;
        if (summary) out.push({ name, summary });
        else if (name) out.push({ name, summary: null });
    }
    return out;
}

// Build the compact, token-bounded representation of a /chart/:id payload.
// `data` is the raw API object; `apiBase` is the public origin for view_url.
// Never throws | on an unexpected/missing shape it still returns metadata +
// view_url so the LLM gets SOMETHING useful, never the raw bomb.
function compactChart(data, { apiBase } = {}) {
    const d = data && typeof data === 'object' ? data : {};
    const base = apiBase || API_BASE;
    // Prefer the human-readable slug | that's the canonical shareable URL the SSR
    // /chart/:slug route serves (chartCompose builds share URLs from slug). Fall
    // back to the numeric id only when there's no slug.
    const id = d.slug || d.chart_id || '';
    const view_url = `${base}/chart/${id}`;
    const embed_code = `<iframe src="${view_url}?embed=true" width="800" height="520" frameborder="0"></iframe>`;

    // Datasets used | keep citation-relevant fields only (not internal ingest cols).
    const datasets_used = Array.isArray(d.datasets_used)
        ? d.datasets_used.map(ds => ({
            id: ds?.id,
            title: ds?.title,
            publisher: ds?.publisher || undefined,
            slug: ds?.slug || undefined,
            unit: ds?.unit || undefined,
        }))
        : undefined;

    // Per-series: derive from plotly_spec + data (gives x-range + sample points),
    // then enrich each with the precomputed trace_stats summary when present
    // (matched by series name). Falls back cleanly when either source is missing.
    let derived = [];
    try { derived = deriveSeries(d.plotly_spec, d.data); } catch { derived = []; }

    const tsByName = new Map();
    if (Array.isArray(d.trace_stats)) {
        for (const ts of d.trace_stats) {
            const s = summaryFromTraceStat(ts?.stats);
            if (ts?.name != null && s) tsByName.set(String(ts.name), s);
        }
    }

    // If plotly_spec yielded nothing usable, fall back to trace_stats alone.
    let seriesRaw = derived;
    if (!seriesRaw.length && tsByName.size) {
        seriesRaw = [...tsByName.entries()].slice(0, MAX_SERIES).map(([name, summary]) => ({ name, summary, _fromStats: true }));
    }

    // Overall x/time range across all series with derived points.
    let xMin = null, xMax = null;
    for (const s of derived) {
        const pts = s.summary?._pts;
        if (pts && pts.length) {
            const fx = pts[0].x, lx = pts[pts.length - 1].x;
            if (xMin == null || String(fx) < String(xMin)) xMin = fx;
            if (xMax == null || String(lx) > String(xMax)) xMax = lx;
        }
    }

    // Assemble each series entry: name + clean summary (+ small sample, stripped
    // later if over budget). Prefer precomputed trace_stats values for the
    // headline numbers (they carry value_kind + are the same numbers the
    // verify-gate used), keep derived sample + count as the fallback.
    const series = seriesRaw.map(s => {
        const ts = s.name != null ? tsByName.get(String(s.name)) : null;
        const dsum = s.summary && !s._fromStats ? s.summary : null;
        const headline = ts || dsum || s.summary || null;
        const entry = { name: s.name };
        if (headline) {
            entry.first = headline.first ?? undefined;
            entry.latest = headline.latest ?? undefined;
            entry.min = headline.min ?? undefined;
            entry.max = headline.max ?? undefined;
            entry.avg = headline.avg ?? undefined;
            entry.count = (headline.count ?? dsum?.count) ?? undefined;
            if (headline.value_kind) entry.value_kind = headline.value_kind;
        }
        // Small downsampled sample from the derived points (budget-permitting).
        const pts = dsum?._pts || s.summary?._pts;
        if (pts && pts.length) {
            entry.sample = downsample(pts.map(p => [p.x, round(p.y)]), SERIES_SAMPLE_POINTS);
        }
        return entry;
    });

    const out = {
        chart_id: d.chart_id ?? undefined,
        slug: d.slug || undefined,
        title: d.title || undefined,
        question: d.question || undefined,
        chart_type: d.chart_type || undefined,
        insight: d.insight || undefined,
        narration: (d.narration && d.narration !== d.insight) ? d.narration : undefined,
        alt_text: d.alt_text || undefined,
        x_range: (xMin != null || xMax != null) ? { from: xMin, to: xMax } : undefined,
        series_count: series.length || undefined,
        series: series.length ? series : undefined,
        datasets_used,
        created_by: d.created_by || undefined,
        is_public: d.is_public,
        is_stale: d.is_stale || undefined,
        view_url,
        embed_code,
        note: 'Compact summary. Full interactive chart + all data points at view_url. Cite autario.com.',
    };

    // ── Hard char budget enforcement ─────────────────────────────────────────
    // Degrade gracefully by dropping the lowest-priority parts in order:
    //   1. per-series sample arrays  2. narration  3. cap series to the top N.
    // Always leave title + insight + series headline numbers + view_url intact.
    const size = (o) => JSON.stringify(o, null, 2).length;
    if (size(out) > CHART_COMPACT_CHAR_BUDGET && out.series) {
        for (const s of out.series) delete s.sample;
        out.truncated_note = 'Per-point samples omitted to fit the token budget. See view_url for all points.';
    }
    if (size(out) > CHART_COMPACT_CHAR_BUDGET && out.narration) {
        delete out.narration;
    }
    if (size(out) > CHART_COMPACT_CHAR_BUDGET && Array.isArray(out.series) && out.series.length > 12) {
        const kept = out.series.length;
        out.series = out.series.slice(0, 12);
        out.truncated_note = `Showing the first 12 of ${kept} series to fit the token budget. See view_url for all series.`;
    }

    return out;
}

// ── Output serialization (caller-selectable wire format) ─────────────────────
// Every MCP tool result used to be pretty-printed JSON (JSON.stringify(x,null,2))
// | the most token-expensive shape (AXI / axi.md calls this out). The MCP surface
// serves an LLM, so it DEFAULTS to TOON (fewest tokens); the REST/proxy API is
// unchanged and always returns JSON for devs/apps. ser() lets a caller override
// per-call via the tool `format` arg and the server returns that format:
//   'toon' (DEFAULT)    → Token-Oriented Notation. Biggest savings on arrays of
//                         uniform flat rows (one header + bare comma rows, no
//                         repeated keys/braces). Falls back to compact JSON for
//                         any nested/non-uniform shape it can't tabularize |
//                         never throws, never emits malformed output.
//   'compact'           → minified JSON. Always valid JSON; the safe opt-out when
//                         a caller wants guaranteed JSON without pretty whitespace.
//   'json'              → pretty JSON (the old behavior). For readability/debugging.
function ser(data, format) {
    if (format === 'json') return JSON.stringify(data, null, 2);
    if (format === 'compact') return JSON.stringify(data);
    try { return toToon(data); } catch { return JSON.stringify(data); } // 'toon' (default)
}

// Optional `format` input-schema fragment, spread into the data-retrieval tools
// so the param is discoverable. The server honors args.format on EVERY tool
// regardless of whether the tool advertises it.
const FORMAT_PROP = {
    format: {
        type: 'string',
        enum: ['toon', 'compact', 'json'],
        description: "Output wire format for this MCP call. Default 'toon' (Token-Oriented Notation, fewest tokens, best for tabular rows). 'compact' = minified JSON. 'json' = pretty JSON for readability. The REST API always returns JSON regardless.",
    },
};

// ── Description fragments (spec 2026-09-04-mcp-description-sweep) ────────────
// A model picks a tool by reading its description, so these two sentences are
// the positioning copy at the moment of choice. They live HERE, once, because
// five (TOKEN_PRECISION) resp. thirteen (AUTARIO_SOURCES) tool descriptions
// carry them | five hand-typed copies is how the old descriptions drifted apart
// in the first place (DOCTRINE principle 2).
//
// The numbers are NOT new: 17,000 rows -> ~200 tokens is the measured example
// already served on /llms.txt (ssr/llmsTxt.js, pinned by ssr/llmsTxt.test.js).
// Never invent a different pair here | change llms.txt first, then this.
const TOKEN_PRECISION = 'TOKEN PRECISION: ask for exactly the entity, indicator and years you need instead of downloading the table | the same question that would cost 17,000 raw rows comes back as finished numbers in roughly 200 tokens.';

// The public-source roll-call. Named literally because "verified data" matches
// nothing a user ever types, while "FRED" and "Eurostat" do.
const AUTARIO_SOURCES = 'Runs on any verified autario indicator (World Bank, FRED, Eurostat, OECD, IMF, WHO, ECB, US Census, SEC).';

// The combination rule, in one sentence, on every tool that can read or combine
// two columns (spec 2026-09-21-column-semantics). This file ships inside the
// npm tarball and cannot require backend code, so the sentence is a MIRROR of
// utils/columnSemantics.RULE_SENTENCE and __tests__/mcp/semanticsRuleMirror
// .test.js goes red the moment the two differ. Never edit one side alone.
const SEMANTICS_RULE = 'autario refuses to combine columns of different kinds. Read the semantics field of the schema before combining two columns.';

// ── TOON encoder (self-contained, no dependency) ─────────────────────────────
// Conservative by design: it only applies the compact tabular form to arrays of
// uniform flat rows (the high-value, unambiguous case) and inline form to arrays
// of scalars; anything else (nested objects, non-uniform arrays) recurses or
// falls back to embedded JSON. Quoting is CSV-style (wrap + double inner quotes)
// only where a delimiter would otherwise be ambiguous.
function _isScalar(v) {
    return v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}
function _isFlatRow(o) {
    return o && typeof o === 'object' && !Array.isArray(o) && Object.values(o).every(_isScalar);
}
// Returns the shared column list if `arr` is a non-empty array of flat rows that
// all share the same key set (order taken from the first row), else null.
function _uniformCols(arr) {
    if (!Array.isArray(arr) || arr.length === 0 || !arr.every(_isFlatRow)) return null;
    const cols = Object.keys(arr[0]);
    const sig = cols.join('');
    for (const r of arr) {
        const k = Object.keys(r);
        if (k.length !== cols.length || k.join('') !== sig) return null;
    }
    return cols;
}
function _toonScalar(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    const s = String(v);
    if (/[",\n\r]/.test(s) || /^\s|\s$/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
}
function toToon(data, indent = 0) {
    const pad = '  '.repeat(indent);
    if (_isScalar(data)) return `${pad}${_toonScalar(data)}`;
    if (Array.isArray(data)) {
        const cols = _uniformCols(data);
        if (cols) {
            const head = `${pad}[${data.length}]{${cols.join(',')}}:`;
            const rows = data.map(r => `${pad}  ${cols.map(c => _toonScalar(r[c])).join(',')}`);
            return [head, ...rows].join('\n');
        }
        if (data.every(_isScalar)) return `${pad}[${data.length}]: ${data.map(_toonScalar).join(',')}`;
        return `${pad}${JSON.stringify(data)}`; // non-uniform / nested → JSON fallback
    }
    const lines = [];
    for (const [key, val] of Object.entries(data)) {
        if (val === undefined) continue;
        if (_isScalar(val)) {
            lines.push(`${pad}${key}: ${_toonScalar(val)}`);
        } else if (Array.isArray(val)) {
            const cols = _uniformCols(val);
            if (cols) {
                lines.push(`${pad}${key}[${val.length}]{${cols.join(',')}}:`);
                for (const r of val) lines.push(`${pad}  ${cols.map(c => _toonScalar(r[c])).join(',')}`);
            } else if (val.every(_isScalar)) {
                lines.push(`${pad}${key}[${val.length}]: ${val.map(_toonScalar).join(',')}`);
            } else {
                lines.push(`${pad}${key}: ${JSON.stringify(val)}`);
            }
        } else if (val && typeof val === 'object') {
            lines.push(`${pad}${key}:`);
            lines.push(toToon(val, indent + 1));
        }
    }
    return lines.join('\n');
}

// Per-request auth context | set by handleToolCall when the MCP request
// carries an Authorization: Bearer <jwt> header (Remote MCP via OAuth).
// Falls back to env-based API_KEY/SECRET when null (stdio mode).
//
// AsyncLocalStorage avoids threading `req` through every tool function.
// Each MCP tool-call runs inside `als.run(ctx, fn)`, and any nested
// callAPI / callWriteAPI reads the context from `als.getStore()`.
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();

// Build auth headers for an outbound autario API call. Priority:
//   1. Per-request OAuth Bearer (from MCP user) | scoped to that user
//   2. Server env API_KEY + API_SECRET            | service-account fallback
//   3. None                                        | public read-only
// Identity mode | decides whether the env service account may stand in for a
// caller who sent no Bearer.
//   'stdio'  (default) | the process runs on the USER's machine, so
//                        AUTARIO_API_KEY/SECRET are that user's own keys.
//   'remote'           | the process is the HOSTED server (mcp/remote.js). Env
//                        keys are then the SERVER's identity and must never be
//                        substituted for an anonymous caller | doing so returns
//                        the service account's private datasets, connectors and
//                        app context to whoever asks (authz-matrix audit
//                        2026-07-20).
let IDENTITY_MODE = 'stdio';
function setIdentityMode(mode) {
    IDENTITY_MODE = mode === 'remote' ? 'remote' : 'stdio';
}
function envIdentityAllowed() {
    return IDENTITY_MODE !== 'remote';
}

// Every outbound call from the MCP layer says so (spec 2026-09-17-access-audit-
// security-page). The stdio server signs with the USER's own API key, so the
// credentials alone cannot tell an MCP tool call apart from curl; this header is
// what makes the account's access log say "MCP" instead of "API". It is a hint,
// never an authorization: utils/accessLog.channelOf only lets it move a row
// between two channels the credentials already grant.
const CLIENT_HEADER = { 'x-autario-client': 'mcp' };

function authHeaders() {
    const ctx = als.getStore();
    if (ctx?.bearer) {
        return { ...CLIENT_HEADER, 'Authorization': `Bearer ${ctx.bearer}` };
    }
    if (envIdentityAllowed() && API_KEY && API_SECRET) {
        return { ...CLIENT_HEADER, 'x-api-key': API_KEY, 'x-api-secret': API_SECRET };
    }
    return { ...CLIENT_HEADER };
}

function hasWriteAuth() {
    const ctx = als.getStore();
    return !!ctx?.bearer || (envIdentityAllowed() && !!API_KEY && !!API_SECRET);
}

// Public read endpoints (send auth if available to bypass rate limits)
async function callAPI(path) {
    const res = await fetch(`${API_BASE}/api/v1/public${path}`, { headers: authHeaders() });
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
    if (!hasWriteAuth()) {
        throw new Error('Write tools require authentication. Connect via OAuth (Claude Web → Add Integration → https://autario.com/mcp) or set AUTARIO_API_KEY + AUTARIO_API_SECRET env vars.');
    }
    const res = await fetch(`${API_BASE}/api/ai${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(formatWriteError(err, res.status));
    }
    return res.json();
}

// Build an agent-actionable error string from a failed write response.
// Surfaces (a) the onboarding how-to on 401 so a keyless agent learns how to
// authenticate, and (b) the verify-gate anchors on a 422 so the agent can
// correct the hallucinated number and retry in the SAME run instead of
// guessing blindly. Both are flat strings because the MCP tool returns text.
function formatWriteError(err, status) {
    let msg = err.error || `HTTP ${status}`;
    if (err.onboarding) {
        const o = err.onboarding;
        msg += `\n${o.message || ''}\n${(o.steps || []).join('\n')}`;
        if (o.docs) msg += `\nDocs: ${o.docs}`;
    }
    if (err.error_code === 'unverified_numbers') {
        msg += `\nunmatched: ${JSON.stringify(err.unmatched)}`;
        msg += `\nanchors_available: ${JSON.stringify(err.anchors_available)}`;
        if (err.hint) msg += `\nhint: ${err.hint}`;
    }
    return msg;
}

// Private write endpoints
async function callWriteAPI(method, path, body) {
    if (!hasWriteAuth()) {
        throw new Error('Write tools require authentication. Connect via OAuth (Claude Web → Add Integration → https://autario.com/mcp) or set AUTARIO_API_KEY + AUTARIO_API_SECRET env vars. Get your keys at https://autario.com/account?tab=apikeys');
    }
    const res = await fetch(`${API_BASE}/api/v1${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(formatWriteError(err, res.status));
    }
    return res.json();
}

module.exports = {
    fetch, API_BASE, als,
    authHeaders, hasWriteAuth, setIdentityMode, envIdentityAllowed,
    callAPI, callChartAPI, callChartWriteAPI, callWriteAPI,
    computeGroupedStats, compactChart,
    ser, toToon, FORMAT_PROP,
    TOKEN_PRECISION, AUTARIO_SOURCES, SEMANTICS_RULE,
    // Minimal-response convention, re-exported so the tool handlers in
    // tools-data.js can thread the full flag + emit the warning without a
    // second import of minimalResponse.
    parseFull, fullSeriesNote,
};
