#!/usr/bin/env node
// backend/mcp/server.js
// Autario MCP Server | stdio transport for Claude Desktop, Cursor, Cline, etc.
//
// Usage (local):
//   node server.js
//   AUTARIO_API_URL=https://autario.com node server.js
//
// Claude Desktop config (~/.config/claude/claude_desktop_config.json on Mac/Linux,
// %APPDATA%\Claude\claude_desktop_config.json on Windows):
//   {
//     "mcpServers": {
//       "autario": {
//         "command": "npx",
//         "args": ["autario-mcp"]
//       }
//     }
//   }

const { Server }               = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

// Single source of truth for tool definitions + handlers.
// Shared with the HTTP transport in remote.js.
const { TOOLS, handleToolCall } = require('./tools');

const PKG_VERSION = require('./package.json').version;

const server = new Server(
    { name: 'autario', version: PKG_VERSION },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return handleToolCall(request.params.name, request.params.arguments || {});
});

(async () => {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`autario-mcp v${PKG_VERSION} ready (${TOOLS.length} tools)`);
})().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
