# cli2mcp-gateway

> Wrap any CLI as a Streamable HTTP MCP server with bearer / OAuth 2.1 / Auth0 auth, CORS, and rate limiting.
> **Dual transport**: same CLI, exposed as either stdio MCP (for local agents) or HTTP MCP (for remote / team use).

---

## What it does

`cli2mcp-gateway` consumes a downstream `cli2mcp` stdio MCP server and re-exposes it as:

| Transport | Use case | Entry point |
|---|---|---|
| **stdio** | Local agents (Claude Code, Codex, Cursor) spawning one process per session | `node src/server.mjs serve` |
| **HTTP** | Remote agents hitting a shared bearer / OAuth / Auth0 endpoint | `node src/server.mjs serve --http` |

The business layer (`createServer`) is shared between transports. Only the transport plumbing differs.

Built on top of the [`cli2mcp`](https://www.npmjs.com/package/cli2mcp) npm package (which itself wraps a CLI by inferring its schema from `--help`).

---

## Install

```bash
git clone https://github.com/drtx32/cli2mcp-gateway.git
cd cli2mcp-gateway
npm install
cp .env.example .env   # then edit .env
```

Requires Node.js ≥ 20.

---

## Quick start — HTTP mode

The default. Lets any MCP-aware HTTP client reach your CLI remotely.

```bash
cp .env.example .env
# edit .env — see "Configuration" below
npm start
```

Sanity check:

```bash
curl http://127.0.0.1:3101/health
# → {"ok":true,"authMode":"bearer","toolNames":["..."],"downstreamConnected":true}
```

Full MCP handshake from any HTTP client (curl example):

```bash
# 1) initialize → get session id
SID=$(curl -s -i -X POST http://127.0.0.1:3101/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"x","version":"0"}},"id":1}' \
  | grep -i "^mcp-session-id:" | awk '{print $2}' | tr -d '\r')

# 2) ack
curl -X POST http://127.0.0.1:3101/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $MCP_TOKEN" -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3) call tools
curl -X POST http://127.0.0.1:3101/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $MCP_TOKEN" -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":2}'
```

---

## Quick start — stdio mode

For local agents that spawn one MCP process per session. No HTTP, no token — the parent agent is trusted.

```bash
npm run stdio
```

Or via Claude Code / Codex MCP config:

```json
{
  "mcpServers": {
    "my-cli": {
      "command": "node",
      "args": ["/path/to/cli2mcp-gateway/src/server.mjs", "serve"]
    }
  }
}
```

---

## Configuration (env vars)

All config flows through environment variables. See `.env.example` for the full list. Key ones:

| Var | Default | Notes |
|---|---|---|
| `HOST` | `127.0.0.1` | `0.0.0.0` to expose on LAN |
| `PORT` | `3100` | HTTP listen port |
| `AUTH_MODE` | `bearer` | `bearer` \| `oauth` \| `both` |
| `MCP_TOKEN` | (random per boot) | Static bearer token. **Set in production.** |
| `CLI2MCP_COMMAND` | `rg` | Downstream CLI binary on `$PATH` |
| `CLI2MCP_NAME` | `ripgrep` | MCP tool name to expose |
| `CLI2MCP_CWD` | `./sandbox` | Working directory passed to the CLI |
| `PUBLIC_ENDPOINT` | `http://$HOST:$PORT` | Required `https://...` when OAuth enabled |
| `OAUTH_USERNAME` / `OAUTH_PASSWORD` | `admin` / `change-me` | **Replace before any non-local use** |
| `AUTH0_ISSUER` / `AUTH0_AUDIENCE` | (empty) | Enables Auth0 JWT verification |
| `CORS_ORIGINS` | (empty) | Comma-separated allowlist; empty = browser clients blocked |
| `RATE_LIMIT_RPS` / `RATE_LIMIT_BURST` | `20` / `40` | Per-IP token bucket |
| `STDIO_BOOT_TIMEOUT_SEC` | `0` | 0 = wait forever for downstream connect (recommended) |
| `STDIO_IDLE_TIMEOUT_SEC` | `0` | 0 = no idle exit (stdio only) |

### Auth modes

- **`bearer`** — single static `MCP_TOKEN`. Easiest for personal/team use.
- **`oauth`** — full OAuth 2.1 with PKCE, dynamic client registration, refresh tokens. Use this for ChatGPT / Claude Desktop / browser clients.
- **`both`** — accept either. Handy during migration.
- **Auth0** — add `AUTH0_ISSUER` + `AUTH0_AUDIENCE` to verify Auth0 JWTs alongside the others.

OAuth is required to be served over HTTPS in non-localhost deployments; the gateway refuses to start otherwise.

---

## How a downstream tool call flows

```
HTTP client                          gateway                       cli2mcp subprocess
  │                                    │                                  │
  │  POST /mcp  (Bearer + JSON-RPC)    │                                  │
  ├───────────────────────────────────▶│                                  │
  │                                    │  stdio (JSON-RPC)                │
  │                                    ├─────────────────────────────────▶│
  │                                    │                                  │  spawn $CLI2MCP_COMMAND
  │                                    │                                  │  --name $CLI2MCP_NAME
  │                                    │                                  │  --cwd  $CLI2MCP_CWD
  │                                    │                                  │  -- <args from caller>
  │                                    │◀─────────────────────────────────┤
  │                                    │  CLI stdout                      │
  │◀───────────────────────────────────┤                                  │
  │  200 + SSE / JSON                  │                                  │
```

The `args` array you pass in `tools/call.arguments.args` is forwarded verbatim to the downstream CLI as positional arguments.

---

## Why not just `cli2mcp` directly?

You can — `npx cli2mcp <command>` is fine for stdio use. The gateway adds:

- **HTTP transport** with bearer / OAuth 2.1 / Auth0 (cli2mcp is stdio only)
- **CORS** for browser-based MCP clients
- **Per-IP rate limiting**
- **Graceful shutdown** with drain timeout
- **stdio lifecycle hardening** (parent watchdog, idle timeout, boot timeout)
- **Centralized env-driven config** with sensible defaults

---

## Files

```
cli2mcp-gateway/
├── src/
│   └── server.mjs     # dual-transport entry + HTTP server
├── .env.example       # configuration template
├── .gitignore
├── package.json
├── README.md
└── LICENSE
```

`sandbox/` is the default working directory passed to the downstream CLI. Create it or set `CLI2MCP_CWD` to your own.

---

## License

MIT © drtx32