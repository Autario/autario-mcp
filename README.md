# autario-mcp

MCP server for [autario](https://autario.com) | Search, query, and publish charts across 2,500+ verified public datasets.

## Quick Start

```json
{
  "mcpServers": {
    "autario": {
      "command": "npx",
      "args": ["autario-mcp"]
    }
  }
}
```

Or install globally:

npm install -g autario-mcp

What it does
Connect any MCP-compatible AI (Claude, ChatGPT, Cursor) to 2,500+ verified datasets from World Bank, IMF, Eurostat, FRED, SIPRI, IEA, NASA, and NOAA.

12 tools available:

Tool	Description
search_datasets	Search across all datasets by keyword or category
get_dataset_info	Get metadata for a specific dataset
get_dataset_schema	Get column names and types
query_dataset	Query with filters, sorting, pagination
list_charts	Browse published visualizations
get_chart	Get a chart with full Plotly spec
publish_chart	Publish a new chart from a Plotly spec
update_chart	Update an existing chart
create_dataset	Create a new dataset
write_rows	Append data to a dataset
clear_rows	Clear all rows from a dataset
delete_dataset	Delete a dataset
Example
Ask your AI: "Compare military spending between USA, China, and Russia since 1960"

The AI will:

Search autario for military spending data
Query the SIPRI dataset
Build a Plotly chart spec
Publish it to autario.com
Result: autario.com/chart/XGhjrwCS

Remote MCP
You can also connect via HTTP (no npm install needed):


https://autario.com/mcp
API Keys
Reading data is free — no key needed. For publishing charts or creating datasets, get free API keys at autario.com/account.

Data Sources
World Bank, IMF, Eurostat, OECD, FRED, WHO, SIPRI, IEA, FAO, NASA, NOAA, BLS, UNODC — 2,500+ datasets covering economics, trade, health, demographics, energy, military, environment, and more.

Links
Platform: autario.com
DataStore: autario.com/datastore
API Docs: autario.com/documentation
npm: npmjs.com/package/autario-mcp
Smithery: smithery.ai/server/autario/data
License
MIT
