// backend/mcp/minimalResponse.js
// OWNED BY Track A
//
// ONE shared minimal-response convention for the API + MCP surface.
// Lives INSIDE backend/mcp because this file ships in the autario-mcp npm
// package (package.json "files") and npm cannot include files outside the
// package root — backend/utils/minimalResponse.js re-exports from here so
// backend consumers keep their import path and the logic still lives once.
//
// WHY: the LLM/GEO channel's whole value is returning ONLY what the question
// asks by default; the full raw time series only on EXPLICIT request, with a
// token-cost warning (Niko 2026-06-28). Before this module that rule was
// enforced reactively by three independent compactors with no shared
// convention (compactDataset, compactChart, computeIndicatorStats), and the
// worst offenders computed a correct SUMMARY but ALSO shipped the full raw
// series by default. This is the single home for:
//   - parseFull(query)        : canonical `full` flag (alias `include_series`)
//   - summarizeSeries(rows)   : the per-series {first,latest,min,max,avg,count}
//   - downsample(arr, max)    : even thinning that always keeps first+last
//   - fullSeriesNote(n)       : the standard token-cost warning string
//
// Pure module: no DB, no HTTP, no side-effects. Consumed by both the
// controllers (ontologyQueryController, statsController) and the MCP layer
// (tools-common, tools-data).

// ── Numeric helpers ──────────────────────────────────────────────────────────
function num(v) {
    if (v == null || v === '') return NaN;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
}

// Round to 4 decimals; null-safe. Matches the historical rounding of both
// computeIndicatorStats (Math.round(x*1e4)/1e4) and summarizeXY (+n.toFixed(4))
// — both are the same value for finite numbers, so consolidating here is
// behavior-preserving.
function round4(x) {
    return (x == null || !Number.isFinite(Number(x))) ? null : Math.round(Number(x) * 1e4) / 1e4;
}

// ── full flag ────────────────────────────────────────────────────────────────
// Canonical query flag = `full`; accept `include_series` as an alias so an
// agent that asks for "the full series" with either name gets it. Truthy on
// boolean true or the usual string forms; everything else (absent, "0",
// "false", "") is false → minimal by default.
function isTruthy(v) {
    if (v === true) return true;
    if (typeof v === 'number') return v === 1;
    if (typeof v === 'string') return /^(1|true|yes|on)$/i.test(v.trim());
    return false;
}

function parseFull(query) {
    if (!query || typeof query !== 'object') return false;
    return isTruthy(query.full) || isTruthy(query.include_series);
}

// ── series summary ───────────────────────────────────────────────────────────
// Reduce a time series to the canonical {first,latest,min,max,avg,count} block.
// `rows` is an array of objects; tKey/vKey name the time + value fields
// (defaults t/v, the ontology fetch shape). Each entry carries {t,v} where v is
// the rounded numeric value. Returns null when no row has a parseable value.
//
// `_pts` (sorted {t,v} numerics) is attached for callers that still need the
// raw points (x-range, sample, change-pct); strip it before emitting.
function summarizeSeries(rows, { tKey = 't', vKey = 'v' } = {}) {
    const pts = [];
    for (const r of (Array.isArray(rows) ? rows : [])) {
        if (!r) continue;
        const v = num(r[vKey]);
        if (!Number.isNaN(v)) pts.push({ t: r[tKey], v });
    }
    if (!pts.length) return null;
    pts.sort((a, b) => String(a.t).localeCompare(String(b.t)));
    let min = pts[0], max = pts[0], sum = 0;
    for (const p of pts) {
        if (p.v < min.v) min = p;
        if (p.v > max.v) max = p;
        sum += p.v;
    }
    const first = pts[0], latest = pts[pts.length - 1];
    return {
        first:  { t: first.t,  v: round4(first.v) },
        latest: { t: latest.t, v: round4(latest.v) },
        min:    { t: min.t,    v: round4(min.v) },
        max:    { t: max.t,    v: round4(max.v) },
        avg: round4(sum / pts.length),
        count: pts.length,
        _pts: pts, // internal — strip before output
    };
}

// ── downsample ───────────────────────────────────────────────────────────────
// Evenly downsample an array to at most `max` items, always keeping first+last.
// Promoted from tools-common.js so the whole minimal-response surface shares one
// implementation.
function downsample(arr, max) {
    if (!Array.isArray(arr) || arr.length <= max) return arr || [];
    if (max <= 2) return [arr[0], arr[arr.length - 1]];
    const out = [];
    const step = (arr.length - 1) / (max - 1);
    for (let i = 0; i < max; i++) out.push(arr[Math.round(i * step)]);
    return out;
}

// ── token-cost warning ───────────────────────────────────────────────────────
// The standard note emitted on ANY full-data path. Keeps the wording uniform so
// agents learn the same lesson everywhere: the stats block is usually enough.
function fullSeriesNote(n) {
    const count = Number.isFinite(n) ? `${n} points` : 'all points';
    return `full series returned (${count}); for analysis the stats block above is usually enough. Omit full=true to get only the summary.`;
}

module.exports = {
    num, round4,
    parseFull, isTruthy,
    summarizeSeries,
    downsample,
    fullSeriesNote,
};
