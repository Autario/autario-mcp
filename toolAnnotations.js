// backend/mcp/toolAnnotations.js
// The RULE for MCP tool annotations. Pure logic, no IO, no tool list.
//
// WHY THIS FILE EXISTS
// Anthropic's Connectors Directory submission requirements (fetched 2026-09-22,
// https://claude.com/docs/connectors/building/submission) say, verbatim:
//
//   "Tool annotations: All tools must include a `title` and the applicable
//    `readOnlyHint` or `destructiveHint`"
//
// and the submission portal's Tools step says a server's tools "sync
// automatically ... grouped by whether their annotations declare them read-only
// or write (tools without annotations are grouped separately). If any tools are
// flagged for missing titles or annotations, fix them on your server before
// submitting." OpenAI's app submission reads the same MCP `annotations` object,
// so one declaration serves both directories.
//
// WHERE THE VALUES LIVE
// On the tool definition itself, in tools-data.js / tools-viz.js / tools-apps.js.
// That inline object is the ONE declaration and both transports already read it:
// server.js (stdio) and remote.js (HTTP /mcp) each return the same TOOLS array
// from tools.js. This file deliberately does NOT restate what any given tool's
// hints should be | a second name->hints table would be exactly the drift
// machine it exists to prevent. It holds the rule and the checker; the pins at
// the bottom are regression pins, not a source of truth (see PINS).
//
// THE RULE, in autario's own words:
//
//   readOnlyHint    true  = the call cannot change any autario state.
//                           Reports, queries, statistics, metadata, preview links.
//   destructiveHint true  = a successful call REMOVES or REPLACES something that
//                           already existed. Creating a new object, appending
//                           rows and flipping a visibility flag ON are additive
//                           and stay false. Only meaningful when readOnlyHint is
//                           false, and per the MCP spec its default in that case
//                           is TRUE | so a non-destructive writer must say false
//                           out loud, it cannot just omit the field.
//   idempotentHint  true  = repeating the identical call has no FURTHER effect on
//                           the environment. A counter that ticks up on a repeat
//                           (report_data_issue) is not idempotent.
//   openWorldHint   true  = the call makes autario talk to a system OUTSIDE
//                           autario. Writing to autario's own Postgres is a
//                           closed domain, however big the write is. Today this
//                           is true for exactly two tools: refresh_connector
//                           (calls the connected platform's API) and
//                           bubble_or_not (fetches Yahoo + SEC for an unknown
//                           ticker). No other tool, read or write, fetches an
//                           external URL.
//
//   title                 = the human name a client shows instead of the
//                           snake_case tool name. Required by the directory.

// Non-standard keys autario is allowed to carry inside `annotations`. The MCP
// ToolAnnotations object is open, and remote.js derives its auth-gated tool set
// from autarioAuthRequired (it is load-bearing, not decoration). Anything NOT on
// this list is a typo or a private convention sneaking onto a public surface.
const ALLOWED_EXTRA_KEYS = ['autarioAuthRequired'];

const HINT_KEYS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];

/**
 * Check ONE tool definition against the rule.
 * Pure: takes the tool object, returns a list of human-readable problems.
 * An empty list means the tool is directory-ready.
 */
function checkTool(tool) {
    const problems = [];
    const name = tool && tool.name;
    if (!name || typeof name !== 'string') {
        return ['tool has no name'];
    }

    const a = tool.annotations;
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
        // The single failure the directory rejects outright.
        return [`${name}: no annotations object (the Connectors Directory requires title + hints)`];
    }

    // title | required by the directory, and it must be a HUMAN name, not the id.
    if (typeof a.title !== 'string' || !a.title.trim()) {
        problems.push(`${name}: annotations.title is missing or empty`);
    } else {
        if (a.title === name) {
            problems.push(`${name}: annotations.title repeats the tool id instead of naming it for a human`);
        }
        if (!/^[A-Z0-9]/.test(a.title)) {
            problems.push(`${name}: annotations.title "${a.title}" does not start with a capital`);
        }
    }

    // All four hints present and boolean. The directory only demands the
    // applicable one, but a hint that is absent is a hint a client has to guess,
    // so autario declares all four on every tool.
    for (const key of HINT_KEYS) {
        if (typeof a[key] !== 'boolean') {
            problems.push(`${name}: annotations.${key} is ${a[key] === undefined ? 'missing' : `not a boolean (${typeof a[key]})`}`);
        }
    }

    // Contradiction: a tool cannot both change nothing and destroy something.
    if (a.readOnlyHint === true && a.destructiveHint === true) {
        problems.push(`${name}: contradictory | readOnlyHint true with destructiveHint true`);
    }

    // A read-only tool is idempotent by construction: it changes nothing, so a
    // repeat has nothing further to change. Declaring otherwise is a mistake.
    if (a.readOnlyHint === true && a.idempotentHint === false) {
        problems.push(`${name}: contradictory | readOnlyHint true with idempotentHint false`);
    }

    // Unknown keys on a surface that ships to two directories.
    for (const key of Object.keys(a)) {
        if (key === 'title' || HINT_KEYS.includes(key)) continue;
        if (!ALLOWED_EXTRA_KEYS.includes(key)) {
            problems.push(`${name}: unknown annotations key "${key}"`);
        }
    }

    return problems;
}

/** Check a whole tool array. Returns the flattened problem list. */
function checkTools(tools) {
    return tools.flatMap(checkTool);
}

/** The tools that declare a given boolean hint, sorted. Used by the pins. */
function toolsWithHint(tools, key) {
    return tools.filter(t => t.annotations && t.annotations[key] === true).map(t => t.name).sort();
}

// ─── PINS ────────────────────────────────────────────────────────────────────
// These are REGRESSION PINS, not a source of truth: the values live on the tool
// definitions, and the gate asserts the resulting sets equal these. Same device
// as the byte-pinned static sitemap. Changing a hint anywhere fails here, on
// purpose | a reviewer-visible promise ("this tool cannot destroy anything")
// must not be editable without a test turning red.

// Reaches a system outside autario. Measured, not assumed: see the rule above.
const OPEN_WORLD_TOOLS = ['bubble_or_not', 'refresh_connector'];

// Removes or replaces something that already existed.
const DESTRUCTIVE_TOOLS = ['clear_rows', 'delete_dataset', 'refresh_connector', 'unpublish_app', 'update_chart'];

// Read-only but user-scoped or admin-scoped, so remote.js must still demand a
// bearer. This set is what remote.js's authRequiredToolNames() adds on top of
// every writer.
const AUTH_REQUIRED_READ_TOOLS = [
    'ai_visibility_360', 'audience_360', 'get_app_preview_url', 'get_my_workspace',
    'list_chart_candidates', 'list_connectors', 'marketing_report', 'seo_360', 'social_360',
];

module.exports = {
    checkTool,
    checkTools,
    toolsWithHint,
    HINT_KEYS,
    ALLOWED_EXTRA_KEYS,
    OPEN_WORLD_TOOLS,
    DESTRUCTIVE_TOOLS,
    AUTH_REQUIRED_READ_TOOLS,
};
