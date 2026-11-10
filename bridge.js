// backend/mcp/bridge.js
//
// autario-mcp 3: a stdio MCP server that carries NO tool of its own. At start
// it opens a Streamable-HTTP MCP session to the hosted autario server
// (https://autario.com/mcp), answers `initialize` with that server's
// capabilities, and forwards tools/list, tools/call and prompts 1:1. Tool
// definitions, descriptions and handlers live only on the server, so a deploy
// updates every user and nobody publishes a package for a changed sentence
// (spec 2026-10-19-mcp-thin-client). The package changes only when this
// transport changes.
//
// Authentication: AUTARIO_API_KEY + AUTARIO_API_SECRET ride as the x-api-key /
// x-api-secret headers of every request to the server, which verifies them and
// runs each tool as that key's owner. Without them the public tools work and
// every account tool answers how to add a key. No credential is ever printed.

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const {
    CallToolRequestSchema,
    CallToolResultSchema,
    ListToolsRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
    ToolListChangedNotificationSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const PKG_VERSION = require('./package.json').version;

const DEFAULT_URL = 'https://autario.com/mcp';
const KEYS_URL = 'https://autario.com/account?tab=apikeys';
// Report tools (a 360 report, an AI Visibility read) can take longer than the
// SDK's 60 s default request timeout.
const CALL_TIMEOUT_MS = 5 * 60 * 1000;

// Every env name the 2.x README documented keeps working: AUTARIO_API_URL was
// the REST base for local development, so a dev server keeps answering at its
// /mcp. AUTARIO_MCP_URL names the MCP endpoint directly and wins.
function remoteUrl(env = process.env) {
    if (env.AUTARIO_MCP_URL) return env.AUTARIO_MCP_URL;
    if (env.AUTARIO_API_URL) return `${String(env.AUTARIO_API_URL).replace(/\/+$/, '')}/mcp`;
    return DEFAULT_URL;
}

function credentials(env = process.env) {
    const key = env.AUTARIO_API_KEY || '';
    const secret = env.AUTARIO_API_SECRET || '';
    return { key, secret, complete: !!(key && secret), partial: !!(key || secret) && !(key && secret) };
}

function requestHeaders(env = process.env) {
    const c = credentials(env);
    const headers = { 'user-agent': `autario-mcp/${PKG_VERSION}` };
    if (c.complete) {
        headers['x-api-key'] = c.key;
        headers['x-api-secret'] = c.secret;
    }
    return headers;
}

// The SDK's StreamableHTTPError carries the HTTP status as `code`.
function httpStatusOf(err) {
    const code = err && err.code;
    return typeof code === 'number' && code >= 100 && code < 600 ? code : null;
}

// The one line a failed start prints. It names the env names and the key page,
// never a credential value.
function startErrorLine(err, url) {
    const status = httpStatusOf(err);
    if (status === 401 || status === 403) {
        return `autario-mcp: ${url} did not accept AUTARIO_API_KEY / AUTARIO_API_SECRET. Create a key pair at ${KEYS_URL}, or remove both variables to use the public tools only.`;
    }
    // A JSON-RPC error code (negative): the server was reached but the MCP
    // handshake did not complete, for example a timeout or a cut response.
    if (err && typeof err.code === 'number' && err.code < 0) {
        return `autario-mcp: ${url} did not complete the MCP handshake (${String(err.message).split('\n')[0]}). Try again in a minute; set AUTARIO_MCP_URL only if you run your own autario server. API keys (AUTARIO_API_KEY / AUTARIO_API_SECRET): ${KEYS_URL}`;
    }
    if (status) {
        return `autario-mcp: ${url} answered HTTP ${status}. Try again in a minute; set AUTARIO_MCP_URL only if you run your own autario server. API keys (AUTARIO_API_KEY / AUTARIO_API_SECRET): ${KEYS_URL}`;
    }
    const why = (err && err.cause && err.cause.code) || (err && err.code) || (err && err.message) || 'network error';
    return `autario-mcp: cannot reach ${url} (${why}). Check the connection, or set AUTARIO_MCP_URL to another autario server. API keys (AUTARIO_API_KEY / AUTARIO_API_SECRET): ${KEYS_URL}`;
}

function toolError(text) {
    return { content: [{ type: 'text', text }], isError: true };
}

// A server restart or the 30-minute idle eviction leaves a session id the
// server no longer knows: it answers 404, and the request never ran, so one
// fresh session plus one retry is safe even for a write tool.
function sessionGone(err) {
    return httpStatusOf(err) === 404 || /session (expired|not found)/i.test(String(err && err.message));
}

function createBridge({ url = remoteUrl(), headers = requestHeaders(), fetch: fetchImpl, log = (line) => console.error(line) } = {}) {
    let client = null;
    let toolsCache = null;
    let server = null;

    async function openClient() {
        const c = new Client({ name: 'autario-mcp', version: PKG_VERSION }, { capabilities: {} });
        const transport = new StreamableHTTPClientTransport(new URL(url), {
            // JSON answers instead of a chunked event stream: some desktop
            // security suites cut event streams mid-body (remote.js,
            // wantsJsonResponses). The server pushes nothing unsolicited, so
            // nothing is lost.
            requestInit: { headers: { ...headers, 'x-autario-mcp-response': 'json' } },
            ...(fetchImpl ? { fetch: fetchImpl } : {}),
        });
        c.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
            toolsCache = null;
            if (server) await server.sendToolListChanged().catch(() => {});
        });
        await c.connect(transport);
        return c;
    }

    async function closeClient(c) {
        if (!c) return;
        try { await c.close(); } catch { /* already gone */ }
    }

    async function withClient(fn) {
        if (!client) client = await openClient();
        try {
            return await fn(client);
        } catch (err) {
            if (!sessionGone(err)) throw err;
            const stale = client;
            client = null;
            await closeClient(stale);
            client = await openClient();
            return fn(client);
        }
    }

    async function listTools() {
        if (toolsCache) return toolsCache;
        const tools = await withClient(async (c) => {
            const all = [];
            let cursor;
            do {
                const page = await c.listTools(cursor ? { cursor } : {});
                all.push(...(page.tools || []));
                cursor = page.nextCursor;
            } while (cursor);
            return all;
        });
        toolsCache = tools;
        return tools;
    }

    async function callTool(params) {
        try {
            return await withClient((c) => c.request(
                { method: 'tools/call', params },
                CallToolResultSchema,
                { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true },
            ));
        } catch (err) {
            const status = httpStatusOf(err);
            if (status === 401 || status === 403) {
                return toolError(`Tool "${params.name}" needs an autario account. Set AUTARIO_API_KEY and AUTARIO_API_SECRET in this MCP server's env (create a pair at ${KEYS_URL}) and restart your client.`);
            }
            if (status) return toolError(`The autario MCP server answered HTTP ${status} for "${params.name}": ${err.message}`);
            if (err && typeof err.code === 'number') return toolError(`autario: ${err.message}`);
            return toolError(`autario-mcp could not reach ${url} (${(err && err.cause && err.cause.code) || (err && err.message) || 'network error'}). Try again in a minute.`);
        }
    }

    // Connects to the server, builds the stdio-facing Server with the remote's
    // capabilities and pre-fetches the tool list so the client's first
    // tools/list is answered from memory. Throws with a start error line.
    async function start() {
        try {
            client = await openClient();
            await listTools();
        } catch (err) {
            await closeClient(client);
            client = null;
            const e = new Error(startErrorLine(err, url));
            e.cause = err;
            throw e;
        }
        const remoteCaps = client.getServerCapabilities() || {};
        const info = client.getServerVersion() || {};
        const capabilities = { tools: { ...(remoteCaps.tools || {}), listChanged: true } };
        if (remoteCaps.prompts) capabilities.prompts = { ...remoteCaps.prompts };
        const instructions = client.getInstructions && client.getInstructions();
        server = new Server(
            { name: info.name || 'autario', version: info.version || PKG_VERSION },
            { capabilities, ...(instructions ? { instructions } : {}) },
        );
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await listTools() }));
        server.setRequestHandler(CallToolRequestSchema, async (request) => callTool({
            name: request.params.name,
            arguments: request.params.arguments || {},
        }));
        if (remoteCaps.prompts) {
            server.setRequestHandler(ListPromptsRequestSchema, async (request) => withClient((c) => c.listPrompts(request.params)));
            server.setRequestHandler(GetPromptRequestSchema, async (request) => withClient((c) => c.getPrompt(request.params)));
        }
        const creds = credentials();
        if (creds.partial) log('autario-mcp: only one of AUTARIO_API_KEY / AUTARIO_API_SECRET is set, so this session uses the public tools only.');
        log(`autario-mcp v${PKG_VERSION} connected to ${url} (${toolsCache.length} tools, ${headers['x-api-key'] ? 'signed in with your API key' : `public tools only, add AUTARIO_API_KEY + AUTARIO_API_SECRET from ${KEYS_URL} for your own data`})`);
        return server;
    }

    async function close() {
        const c = client;
        client = null;
        await closeClient(c);
        if (server) await server.close().catch(() => {});
    }

    return { start, close, listTools, callTool, get server() { return server; }, url };
}

module.exports = { createBridge, remoteUrl, requestHeaders, credentials, startErrorLine, DEFAULT_URL, KEYS_URL };
