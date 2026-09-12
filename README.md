# 2c8 MCP Server

MCP server that exposes curated tools for working with models and objects in the
[2c8 Modeling Tool](https://www.2c8.com) MT backend API from an AI agent.

OpenAPI reference: https://developer.2c8.com/reference/openapi.json

## Features

- TypeScript MCP server using `@modelcontextprotocol/sdk`
- Dual transport: **stdio** (default) and **Streamable HTTP**
- Auth via `TWO_C8_BASE_URL` + `TWO_C8_API_KEY` (`x-api-key`)
- **Read-only by default** — write tools are only registered when `TWO_C8_ALLOW_WRITES=true`
- Curated tool surface for repositories, models, symbols, canvas, descriptions, relations, queries, and directories

## Requirements

- Node.js 20+

## Setup

```bash
npm install
cp .env.example .env
# edit .env with your MT backend URL and API key
npm run build
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TWO_C8_BASE_URL` | *(required)* | MT backend base URL, e.g. `https://host.example/mt-backend` |
| `TWO_C8_API_KEY` | *(required)* | API key sent as `x-api-key` |
| `TWO_C8_ALLOW_WRITES` | `false` | When `true`, register create/update/delete tools |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `PORT` | `3000` | HTTP listen port |
| `HOST` | `127.0.0.1` | HTTP listen host |

You can also pass `--http` to force Streamable HTTP mode.

## Run

```bash
# stdio (for Cursor / Claude Desktop)
npm start

# Streamable HTTP on /mcp
npm run start:http
```

Health check (HTTP mode): `GET /health`

## Cursor MCP config (stdio)

```json
{
  "mcpServers": {
    "2c8": {
      "command": "node",
      "args": ["/absolute/path/to/2c8-mcp-server/dist/index.js"],
      "env": {
        "TWO_C8_BASE_URL": "https://your-server.example/mt-backend",
        "TWO_C8_API_KEY": "your-api-key",
        "TWO_C8_ALLOW_WRITES": "false"
      }
    }
  }
}
```

## Tools (read-only)

Repositories, models, versions, symbols, canvas/vertices, descriptions, languages,
description types, relations, queries/lists (execute), directories, API versions.

## Tools (writes, when enabled)

Create/update/delete models and symbols, draft create/accept, canvas update,
create/delete vertices and edges, update model/symbol descriptions.

Write request bodies are passed as JSON objects matching the 2c8 OpenAPI DTOs.

## Development

```bash
npm run dev
npm run dev:http
npm run typecheck
```
