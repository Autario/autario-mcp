// backend/mcp/tools.js
// Bridge file | the union of the data + viz tool sets, consumed by both stdio
// (server.js) and remote (remote.js). The actual definitions + handlers live in
// tools-data.js (Track A) and tools-viz.js (Track B); shared infra (auth, API
// helpers, AsyncLocalStorage) in tools-common.js. This file only assembles the
// union and routes a tool-call to the owning handler.
// See DOCTRINE.md ## Two-Agent-Protokoll.

const { als } = require('./tools-common');
const { DATA_TOOLS, handleDataTool } = require('./tools-data');
const { VIZ_TOOLS, handleVizTool } = require('./tools-viz');
const { APP_TOOLS, handleAppTool } = require('./tools-apps');

// Union of all MCP tool definitions. Order: data, then viz, then app tools | MCP
// addresses tools by name, not position, so the order is behavior-neutral.
const TOOLS = [...DATA_TOOLS, ...VIZ_TOOLS, ...APP_TOOLS];

// Lazy-load tracker | optional dep, skip silently if eventTracker isn't
// available (e.g. when this module is loaded by the npm-published autario-mcp
// stdio package which doesn't include the backend folder).
let _trackToolCall = null;
try { _trackToolCall = require('../utils/eventTracker').trackToolCall; } catch { /* npm package | no tracker */ }

async function handleToolCall(name, args, req = null) {
    // Build per-request auth context | the OAuth Bearer token is extracted
    // by mcp/remote.js into req.mcpUser. Stash it in AsyncLocalStorage so
    // every nested callAPI / callWriteAPI sees the same identity for the
    // duration of this tool-call.
    const ctx = req?.mcpUser?._raw
        ? { bearer: req.mcpUser._raw, user: { id: req.mcpUser.id, email: req.mcpUser.email } }
        : null;
    const run = () => {
        if (_trackToolCall) {
            return _trackToolCall(name, args, req, () => _handleToolCallInner(name, args));
        }
        return _handleToolCallInner(name, args);
    };
    if (ctx) {
        return als.run(ctx, run);
    }
    return run();
}

// Route to the owning handler: data first, then viz. Each handler returns
// undefined for a name it doesn't own. Unknown name → explicit error. The
// single try/catch here formats any handler throw into an MCP error response
// (handlers themselves stay try-free, as before the split).
async function _handleToolCallInner(name, args) {
    try {
        const dataResult = await handleDataTool(name, args);
        if (dataResult !== undefined) return dataResult;
        const vizResult = await handleVizTool(name, args);
        if (vizResult !== undefined) return vizResult;
        const appResult = await handleAppTool(name, args);
        if (appResult !== undefined) return appResult;
        throw new Error(`Unknown tool: ${name}`);
    } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
}

module.exports = { TOOLS, handleToolCall };
