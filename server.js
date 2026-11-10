#!/usr/bin/env node
// backend/mcp/server.js
// autario-mcp | the stdio entry for Claude Desktop, Claude Code, Cursor, Cline.
//
// Since 3.0.0 this is a bridge to the hosted autario MCP server (bridge.js):
// the tool list and every tool call come from https://autario.com/mcp, so the
// package never carries a tool description of its own and a server deploy
// updates every install (spec 2026-10-19-mcp-thin-client).
//
// Claude Desktop config (~/.config/claude/claude_desktop_config.json on Mac/Linux,
// %APPDATA%\Claude\claude_desktop_config.json on Windows):
//   {
//     "mcpServers": {
//       "autario": {
//         "command": "npx",
//         "args": ["autario-mcp"],
//         "env": { "AUTARIO_API_KEY": "...", "AUTARIO_API_SECRET": "..." }
//       }
//     }
//   }
//
// Env: AUTARIO_API_KEY + AUTARIO_API_SECRET (optional, your own data and the
// write tools), AUTARIO_MCP_URL (optional, another autario MCP endpoint),
// AUTARIO_API_URL (optional, an autario base URL; its /mcp is used).

const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { createBridge } = require('./bridge');

(async () => {
    const bridge = createBridge();
    let server;
    try {
        server = await bridge.start();
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
    const transport = new StdioServerTransport();
    const shutdown = () => { bridge.close().finally(() => process.exit(0)); };
    transport.onclose = shutdown;
    process.stdin.on('end', shutdown);
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await server.connect(transport);
})().catch((err) => {
    console.error(`autario-mcp: ${err && err.message ? err.message : err}`);
    process.exit(1);
});
