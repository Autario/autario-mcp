# MCP Marketplace Submissions

_Operational tracking file. Update the **Status** + **Last submitted** columns after each push._

## Summary

| Marketplace | Mechanism | Status | Last submitted | URL |
| --- | --- | --- | --- | --- |
| LobeHub | Auto-scrape from GitHub README | live | _auto_ | https://lobehub.com/mcp/autario-autario-mcp |
| Glama | Auto-discover from npm + GitHub | pending re-scan | _auto_ | https://glama.ai/mcp/servers (search "autario") |
| mcp.so | PR against `chatmcp/mcp-directory` | not submitted | n/a | https://mcp.so |
| PulseMCP | Web form + GitHub integration | not submitted | n/a | https://www.pulsemcp.com |
| Smithery | YAML manifest + auto-scan | not submitted | n/a | https://smithery.ai |
| npmjs.org | Auto-publish | live | with each `npm publish` | https://www.npmjs.com/package/autario-mcp |

## After publishing 2.1.0

Run these in order. Steps 1 + 2 are blocking; the rest can be parallelized.

### 1. npm publish (blocking)

```bash
cd backend/mcp
npm publish
```

This is the trigger. Most auto-discovery marketplaces (LobeHub, Glama) re-index from npm and GitHub on a schedule. Allow up to 24 hours.

### 2. Verify the npm tarball ships the right files

```bash
cd backend/mcp
npm pack --dry-run | grep -E '(server.js|tools.js|README.md|package.json)'
```

Expected: all four present. If `tools.js` is missing, `package.json#files` was not updated and `server.js` will throw on install.

### 3. mcp.so | submit PR

mcp.so reads from https://github.com/chatmcp/mcp-directory. Submission is a YAML PR.

```yaml
# servers/autario.yaml
name: autario-mcp
description: 2,700+ public datasets with cross-dataset ontology joins + statistical analysis. Verified data, no hallucinated numbers.
homepage: https://autario.com
repository: https://github.com/autario/autario
license: MIT
language: javascript
runtime: node
install:
  - command: npx
    args: [autario-mcp]
env:
  AUTARIO_API_KEY: optional, required for write tools
  AUTARIO_API_SECRET: optional, required for write tools
tags:
  - data
  - analytics
  - statistics
  - charts
  - world-bank
  - fred
  - eurostat
```

PR target: `https://github.com/chatmcp/mcp-directory` | path under `servers/`. Re-check the repo for the current schema before submitting; the schema evolves.

### 4. PulseMCP | web form

URL: https://www.pulsemcp.com/submit-server (verify path before submitting | exact route changes).

Required fields (have these ready):

- **Name:** autario-mcp
- **Tagline (one line):** Verified data for AI agents. 2,700+ datasets joined under one ontology, plus statistical analysis and chart publishing.
- **GitHub URL:** https://github.com/autario/autario (subdirectory `backend/mcp`)
- **npm URL:** https://www.npmjs.com/package/autario-mcp
- **Install command:** `npx autario-mcp`
- **Categories:** data, analytics, business intelligence
- **Logo:** use the `autario.com` favicon | upload `frontend/public/favicon.png` if a custom one is required.
- **Demo prompt:** _"What drives US inflation? Look at money supply, oil prices, and unemployment."_

### 5. Smithery | manifest

Smithery looks for a `smithery.yaml` at the repo root or the package root. Add `backend/mcp/smithery.yaml`:

```yaml
# backend/mcp/smithery.yaml
startCommand:
  type: stdio
  configSchema:
    type: object
    properties:
      AUTARIO_API_URL:
        type: string
        default: https://autario.com
      AUTARIO_API_KEY:
        type: string
        description: Required for write tools (publish_chart, create_dataset, etc.)
      AUTARIO_API_SECRET:
        type: string
        description: Companion secret for the API key
  commandFunction: |
    (config) => ({
      command: 'npx',
      args: ['autario-mcp'],
      env: {
        AUTARIO_API_URL: config.AUTARIO_API_URL || 'https://autario.com',
        ...(config.AUTARIO_API_KEY ? { AUTARIO_API_KEY: config.AUTARIO_API_KEY } : {}),
        ...(config.AUTARIO_API_SECRET ? { AUTARIO_API_SECRET: config.AUTARIO_API_SECRET } : {}),
      },
    })
```

Then submit at https://smithery.ai/new (verify route before submitting).

### 6. Glama | passive

Glama indexes from npm + GitHub, no submit form needed. Triggered by the npm publish in step 1. To force a re-scan: open the existing listing, scroll to the bottom, click the "Re-scan" / "Refresh" link if present.

## Checklist for the maintainer

After 2.1.0 ships, work through this list and update the table at the top of this file.

- [ ] `npm publish` succeeded, version 2.1.0 visible at https://www.npmjs.com/package/autario-mcp
- [ ] `npm pack --dry-run` includes `tools.js`
- [ ] LobeHub listing shows 28 tools (allow 24h for re-scrape)
- [ ] Glama listing shows 28 tools
- [ ] mcp.so PR opened, link committed in this file
- [ ] PulseMCP form submitted, screenshot of confirmation in this file or an issue
- [ ] `smithery.yaml` committed and Smithery listing live
- [ ] Spot-check: visit https://lobehub.com/mcp/autario-autario-mcp in incognito, confirm the new pitch + ontology section render

## Won't do (out of scope)

- Contact LobeHub directly. They scrape automatically. Reaching out does not jump the queue.
- Build a custom MCP marketplace.
- Per-marketplace UTM variants. The README uses a single `utm_source=mcp_readme` for now. Per-marketplace tracking would require separate README builds, which is over-engineered until conversion volume justifies it.
