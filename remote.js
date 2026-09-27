// backend/mcp/remote.js
// Remote MCP endpoint | mounted as Express middleware at /mcp
// Allows Claude Web (claude.ai), Claude Desktop, and any MCP client to connect via HTTP.
//
// How it works:
// - POST /mcp | Streamable HTTP transport (modern MCP clients)
// - GET  /mcp | SSE transport (legacy MCP clients)
// - DELETE /mcp | close session
//
// Claude Web integration URL: https://autario.com/mcp

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
// What a directory sees when it introspects us. Glama's listing "Autario Data
// Analytics Platform" printed a stale typed dataset count and version 1.0.0
// for months because this text was typed here in July and read from nowhere. ONE
// source now: backend/mcp/server.json, the same description and version the
// npm package and the official registry carry (readmeSync pins the three).
const IDENTITY = (() => {
    const s = require('./server.json');
    return { version: s.version, description: s.description };
})();
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

// Re-use the same tool definitions and handlers from the stdio server
const { TOOLS, handleToolCall } = require('./tools');
const { setIdentityMode } = require('./tools-common');

// This process is the HOSTED server, so the env service account is OUR
// identity, never a stand-in for an anonymous caller. Flip the shared tool
// layer into remote mode at load time: without it, a caller with no Bearer
// silently inherits the server's API keys and reads the service account's
// private datasets / connectors / app context (authz-matrix audit 2026-07-20).
setIdentityMode('remote');

// Tools that need a caller identity to answer correctly | the 401 challenge
// set. Two sources, both mechanical:
//   - readOnlyHint === false           | every write tool
//   - annotations.autarioAuthRequired  | read tools whose data is user-scoped
//                                        (list_connectors, chart candidates)
// A tool whose handler routes through callWriteAPI/callChartWriteAPI MUST be in
// this set; __tests__/security/authzMatrix.test.js enforces that mechanically.
function authRequiredToolNames(tools = TOOLS) {
    return new Set(
        tools
            .filter(t => t.annotations?.readOnlyHint === false || t.annotations?.autarioAuthRequired === true)
            .map(t => t.name)
    );
}

// Close a transport without EVER throwing or rejecting. The MCP SDK's
// StreamableHTTPServerTransport.close() does not reliably return a Promise:
// when it returns undefined, the old `transport.close?.().catch(...)` shape
// reads `.catch` on undefined and throws a synchronous TypeError. Inside the
// eviction setTimeout that throw is UNCAUGHT and crashes the whole process |
// every live MCP session drops ("connection lost") 30 min after any session
// was created, regardless of any tool-call. One close path, used everywhere
// (DOCTRINE Prinzip 2: geteilte Logik einmal).
function safeClose(transport) {
    if (!transport || typeof transport.close !== 'function') return Promise.resolve();
    try {
        const r = transport.close();
        // Normalize void vs Promise; swallow any async rejection.
        return Promise.resolve(r).catch(() => {});
    } catch {
        // Synchronous throw from close() | never let it escape.
        return Promise.resolve();
    }
}

function createMCPMiddleware() {
    const transports = {};

    const PROMPTS = [
        {
            name: 'analyze-dataset',
            description: 'Find and analyze a dataset on a given topic. Returns key statistics and trends.',
            arguments: [{ name: 'topic', description: 'The topic to search for (e.g. "GDP growth", "CO2 emissions", "unemployment")', required: true }],
        },
        {
            name: 'create-chart',
            description: 'Search for data and create a publishable chart visualization on autario.com.',
            arguments: [{ name: 'topic', description: 'What to visualize (e.g. "inflation comparison EU vs USA")', required: true }],
        },
        {
            name: 'compare-countries',
            description: 'Compare a specific metric across countries with data from autario.',
            arguments: [
                { name: 'metric', description: 'The metric to compare (e.g. "life expectancy", "GDP per capita")', required: true },
                { name: 'countries', description: 'Comma-separated country names (e.g. "Germany, France, Japan")', required: true },
            ],
        },
    ];

    function createServer(httpReq = null) {
        const server = new Server(
            { name: 'autario', version: IDENTITY.version },
            { capabilities: { tools: {}, prompts: {} } }
        );
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            // Pass the HTTP request through so eventTracker can classify the
            // client (api_key vs anon vs LLM-via-proxy) from headers + UA.
            return handleToolCall(request.params.name, request.params.arguments || {}, httpReq);
        });
        server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
        server.setRequestHandler(GetPromptRequestSchema, async (request) => {
            const p = PROMPTS.find(p => p.name === request.params.name);
            if (!p) throw new Error(`Prompt not found: ${request.params.name}`);
            const args = request.params.arguments || {};
            if (p.name === 'analyze-dataset') {
                return { messages: [{ role: 'user', content: { type: 'text', text: `Search autario datasets for "${args.topic}". Pick the most relevant dataset, get its schema, query the data, and provide a summary with key statistics, trends, and interesting findings. Use the Per-country statistics from query results for accurate numbers.` } }] };
            }
            if (p.name === 'create-chart') {
                return { messages: [{ role: 'user', content: { type: 'text', text: `Create a chart on autario.com about "${args.topic}". Search datasets, understand the data, then publish a Plotly chart with 3-8 meaningful series. Use accurate numbers from query_dataset statistics in the insight text. Title with date range and pipe separator.` } }] };
            }
            if (p.name === 'compare-countries') {
                return { messages: [{ role: 'user', content: { type: 'text', text: `Compare ${args.metric} across these countries: ${args.countries}. Search autario datasets, query the data for each country, and present a comparison with specific numbers from the data.` } }] };
            }
            return { messages: [{ role: 'user', content: { type: 'text', text: 'Use autario tools to analyze data.' } }] };
        });
        return server;
    }

    // Try to extract a user identity from the Authorization: Bearer header.
    // Returns { id, email, scope, oauth: true } when valid, null otherwise.
    // Used to pin tool-calls to the OAuth user instead of the server's
    // env-based service account. Stateless | JWT verify only, no DB hit.
    function extractBearerUser(req) {
        const h = req.headers['authorization'] || '';
        const m = /^Bearer\s+(.+)$/i.exec(h);
        if (!m) return null;
        try {
            const jwt = require('jsonwebtoken');
            const decoded = jwt.verify(m[1], process.env.JWT_SECRET);
            // Accept both shapes: oauth-issued ({id, email, oauth:true}) and
            // legacy session JWTs ({email}). Normalize to id+email.
            return {
                id: decoded.id || null,
                email: decoded.email,
                scope: decoded.scope || null,
                oauth: !!decoded.oauth,
                _raw: m[1],
            };
        } catch {
            return null;
        }
    }

    return async (req, res, next) => {
        // Only handle /mcp path
        if (req.path !== '/mcp' && req.path !== '/mcp/') return next();

        try {
            if (req.method === 'POST') {
                // Stateless responses for registry scanners (no session, no initialize).
                // Tools/list + prompts/list calls also tracked so we know how often
                // discovery happens (Smithery, Glama poll these; high counts = healthy
                // marketplace presence).
                const body = req.body;
                const sessionId = req.headers['mcp-session-id'];

                // Attach Bearer-user to req so the per-call handler can use
                // it to authenticate write tools as the OAuth user (not the
                // server's env-based default).
                req.mcpUser = extractBearerUser(req);
                let _track = null;
                try { _track = require('../utils/eventTracker').trackToolCall; } catch { /* optional */ }
                if (!sessionId && body?.method) {
                    if (body.method === 'tools/list') {
                        if (_track) _track('_tools_list', {}, req, async () => ({})).catch(() => {});
                        return res.json({ jsonrpc: '2.0', id: body.id, result: { tools: TOOLS } });
                    }
                    if (body.method === 'prompts/list') {
                        if (_track) _track('_prompts_list', {}, req, async () => ({})).catch(() => {});
                        return res.json({ jsonrpc: '2.0', id: body.id, result: { prompts: PROMPTS } });
                    }
                    if (body.method === 'resources/list') {
                        return res.json({ jsonrpc: '2.0', id: body.id, result: { resources: [] } });
                    }
                }

                // Write tools require an authenticated user. If a tools/call
                // for a write tool arrives without a valid Bearer, answer 401
                // + WWW-Authenticate so the MCP client runs the OAuth flow
                // (oauthRoutes.js). Without this challenge the call fails deep
                // inside the tool with a plain "authentication required"
                // error string | the client treats it as a tool failure, not
                // an auth gap, and NEVER triggers OAuth. Result: the connector
                // looks connected (reads work, public data) but writes are
                // permanently unauthenticated. The 401 is what makes a
                // spec-compliant client (Claude, ChatGPT) authorize. Reads
                // stay anonymous | public data needs no login.
                if (body?.method === 'tools/call' && !req.mcpUser) {
                    const toolName = body.params?.name;
                    const AUTH_TOOLS = authRequiredToolNames();
                    if (toolName && AUTH_TOOLS.has(toolName)) {
                        const issuer = process.env.OAUTH_ISSUER || 'https://autario.com';
                        res.set('WWW-Authenticate', `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`);
                        return res.status(401).json({
                            jsonrpc: '2.0',
                            id: body.id ?? null,
                            error: {
                                code: -32001,
                                message: `Tool "${toolName}" needs an authenticated autario account. Authorize the connector (OAuth) to use write tools.`,
                            },
                        });
                    }
                }

                const isInitialize = body?.method === 'initialize';
                let transport;
                if (sessionId && transports[sessionId]) {
                    transport = transports[sessionId];
                } else if (sessionId && !isInitialize) {
                    // Stale session | the client holds a session-id we have no
                    // record of. This is the normal aftermath of a deploy:
                    // the container restarts, the in-memory `transports` map
                    // is wiped, but connected clients keep sending their old
                    // session-id. The old code built a FRESH un-initialized
                    // transport here and fed it a non-initialize request | the
                    // SDK then threw "Server not initialized" forever with no
                    // path to recovery. Per the Streamable HTTP spec, answer
                    // 404 instead: a spec-compliant client drops the dead
                    // session and re-runs `initialize` automatically. This is
                    // what makes every future deploy self-heal.
                    return res.status(404).json({
                        jsonrpc: '2.0',
                        id: body?.id ?? null,
                        error: { code: -32001, message: 'Session expired | please re-initialize' },
                    });
                } else {
                    // New session (no session-id, or an explicit re-initialize)
                    // | create fresh server + transport. Pass the current HTTP
                    // request through so the tracker can read headers/UA per
                    // tool-call.
                    //
                    // Session-tracking is async: the SDK assigns sessionId
                    // INSIDE handleRequest (during the `initialize` JSON-RPC
                    // call), not at construction. The previous version read
                    // `transport.sessionId` before handleRequest fired | it
                    // was always undefined, no session was ever stored, and
                    // every follow-up request created a new uninitialized
                    // transport that 400'd on tools/list. The
                    // `onsessioninitialized` callback fires once the SDK has
                    // the id; we register the mapping there instead.
                    const server = createServer(req);
                    transport = new StreamableHTTPServerTransport({
                        sessionIdGenerator: () => require('crypto').randomUUID(),
                        onsessioninitialized: (sid) => {
                            transports[sid] = transport;
                            // Idle eviction | 30 min after creation. Re-arming
                            // on each call would be tighter but costs a timer
                            // reset per request; the simpler timeout is fine
                            // for our load. The whole body is try-guarded:
                            // a throw inside a timer callback is uncaught and
                            // would crash the process (and every other live
                            // session) | safeClose already swallows close()
                            // errors, the try is belt-and-suspenders.
                            const evict = setTimeout(() => {
                                try {
                                    const t = transports[sid];
                                    if (t) {
                                        delete transports[sid];
                                        safeClose(t);
                                    }
                                } catch (e) {
                                    console.error('MCP session eviction error:', e?.message);
                                }
                            }, 30 * 60 * 1000);
                            // Don't keep the event loop alive just for eviction.
                            if (typeof evict.unref === 'function') evict.unref();
                        },
                    });
                    await server.connect(transport);
                }

                await transport.handleRequest(req, res, req.body);
            } else if (req.method === 'GET') {
                // GET /mcp | return server info + tools list for discovery (Smithery, Glama, etc.)
                res.json({
                    name: 'autario',
                    version: IDENTITY.version,
                    description: IDENTITY.description,
                    tools: TOOLS,
                });
                return;
            } else if (req.method === 'DELETE') {
                const sessionId = req.headers['mcp-session-id'];
                if (sessionId && transports[sessionId]) {
                    const t = transports[sessionId];
                    delete transports[sessionId];
                    await safeClose(t);
                }
                res.writeHead(200);
                res.end();
            } else {
                next();
            }
        } catch (err) {
            console.error('MCP remote error:', err.message);
            if (!res.headersSent) {
                res.status(500).json({ error: 'MCP error: ' + err.message });
            }
        }
    };
}

module.exports = { createMCPMiddleware, safeClose, authRequiredToolNames };
