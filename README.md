# cli2mcp-gateway

> Wrap any CLI as a Streamable HTTP MCP server with bearer / OAuth 2.1 / Auth0 auth, CORS, and rate limiting.
> **Dual transport**: same CLI, exposed as either stdio MCP (for local agents) or HTTP MCP (for remote / team use).

---

## What it does

`cli2mcp-gateway` wraps any CLI as an MCP server. On startup it runs `<cli> --help` and `<cli> <sub> --help` for each subcommand, infers a JSON Schema, and exposes **one MCP tool per (sub)command**.

| Transport | Use case | Entry point |
|---|---|---|
| **stdio** | Local agents (Claude Code, Codex, Cursor) spawning one process per session | `cli2mcp-gateway serve` |
| **HTTP** | Remote agents hitting a shared bearer / OAuth / Auth0 endpoint | `cli2mcp-gateway serve --http` |

The business layer (`createServer`) is shared between transports. Only the transport plumbing differs.

The CLI is spawned directly via `execa()` — no nested MCP client, no extra process hop. Schema inference lives in `src/help-parser.js`.

> Windows note: the published command uses a small Node launcher so `cli2mcp-gateway` runs as a program instead of opening `src/server.mjs` in an editor.

### Example: `parsehub` becomes 4 MCP tools

```text
parsehub_parse      ← matches `parsehub parse <url>`
parsehub_download   ← matches `parsehub download <url> -o <path>`
parsehub_platforms  ← matches `parsehub platforms`
parsehub_set        ← matches `parsehub set <sub-subcommand> ...`
```

Each tool's `inputSchema` is auto-derived from the corresponding `--help` output: positional arguments become a `positional` string array; flags with arg hints (e.g. `-o PATH`) become typed strings; boolean flags stay boolean.

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

### Option A: local install + .env file

```bash
git clone https://github.com/drtx32/cli2mcp-gateway.git
cd cli2mcp-gateway
npm install
cp .env.example .env   # then edit .env
npm start
```

### Option B: global install + env vars on the command line (no .env file)

```bash
npm install -g drtx32/cli2mcp-gateway

# one-shot start with env inline:
MCP_TOKEN=ph_token_12345678 \
CLI_COMMAND=parsehub \
CLI_CWD=/tmp/parsehub-downloads \
HOST=127.0.0.1 \
PORT=3101 \
PUBLIC_ENDPOINT=http://127.0.0.1:3101 \
cli2mcp-gateway serve --http
```

Or export once into your shell profile (`~/.zshrc` / `~/.bashrc`):

```bash
export MCP_TOKEN=ph_token_12345678
export CLI_COMMAND=parsehub
export CLI_CWD=/tmp/parsehub-downloads
export HOST=127.0.0.1
export PORT=3101
export PUBLIC_ENDPOINT=http://127.0.0.1:3101

cli2mcp-gateway serve --http
```

### `serve` flags

`serve` accepts only these mode switches:

- `--http` to use HTTP transport
- `--stdio` to force stdio transport

If you pass neither flag, `serve` defaults to stdio. `winapp` is not a supported subcommand.

The `.env` file is purely a convenience — every variable it can hold can be passed via the shell instead.

Sanity check:

```bash
curl http://127.0.0.1:3101/health
# → {"ok":true,"authMode":"bearer","toolNames":["parsehub_parse","parsehub_download","parsehub_platforms","parsehub_set"],"cliResolved":true}
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
      "args": ["/path/to/cli2mcp-gateway/bin/cli2mcp-gateway.cjs", "serve"]
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
| `CLI_COMMAND` | `rg` | Downstream CLI binary on `$PATH`. Must support `--help`. |
| `CLI_CWD` | process cwd | Working directory passed to the CLI |
| `CLI_SUBCOMMANDS` | (auto) | Comma-separated list. Empty = auto-discover from `<cli> --help`. |
| `CLI_TIMEOUT_MS` | `60000` | Per-call CLI timeout (execa). |
| `PUBLIC_ENDPOINT` | `http://$HOST:$PORT` | Required `https://...` when OAuth enabled |
| `OAUTH_USERNAME` / `OAUTH_PASSWORD` | `admin` / `change-me` | **Replace before any non-local use** |
| `AUTH0_ISSUER` / `AUTH0_AUDIENCE` | (empty) | Enables Auth0 JWT verification |
| `ALLOWED_HOSTS` | (empty) | Host header allowlist (anti-DNS-rebinding) |
| `MCP_ALLOWED_IPS` | (empty) | Source-IP allowlist. Comma-separated. Accepts bare IP (`1.2.3.4`), IP:port (`1.2.3.4:3101`), CIDR (`10.0.0.0/8`), and IPv6. Empty = allow all. |
| `CORS_ORIGINS` | (empty) | Comma-separated allowlist; empty = browser clients blocked |
| `RATE_LIMIT_RPS` / `RATE_LIMIT_BURST` | `20` / `40` | Per-IP token bucket |
| `STDIO_BOOT_TIMEOUT_SEC` | `0` | 0 = wait forever for `<cli> --help` (recommended) |
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
HTTP client                          gateway                       downstream CLI
  │                                    │                                  │
  │  POST /mcp  (Bearer + JSON-RPC)    │                                  │
  ├───────────────────────────────────▶│                                  │
  │                                    │  execa(cmd, [sub, --flag value]) │
  │                                    ├─────────────────────────────────▶│
  │                                    │                                  │  spawn $CLI_COMMAND
  │                                    │                                  │  cwd = $CLI_CWD
  │                                    │                                  │  args = buildArgv(shape, args)
  │                                    │◀─────────────────────────────────┤
  │                                    │  CLI stdout / stderr             │
  │◀───────────────────────────────────┤                                  │
  │  200 + SSE / JSON                  │                                  │
```

`buildArgv(shape, args)` translates the MCP `tools/call.arguments` object into argv:

- Each flag defined in the inferred schema becomes `--<long> <value>` when truthy / non-empty.
- Positionals come from `arguments.positional` (a string array) in declared order.

### Concrete example

Calling `parsehub_download` to fetch a Xiaohongshu note:

```json
{
  "name": "parsehub_download",
  "arguments": {
    "positional": ["https://www.xiaohongshu.com/discovery/item/6a5ccd97..."],
    "o": "/tmp/downloads"
  }
}
```

becomes:

```
parsehub download https://www.xiaohongshu.com/discovery/item/6a5ccd97... -o /tmp/downloads
```

The CLI's stdout (file list, JSON, etc.) is returned verbatim as the MCP tool result.

---

## Why a custom gateway?

Wrapping a CLI as an MCP tool has its own set of pain points beyond what the raw CLI provides. This gateway adds:

- **HTTP transport** with bearer / OAuth 2.1 / Auth0 (raw CLIs are stdio only)
- **Per-subcommand tool discovery** from `--help` output (no manual schema authoring)
- **Per-IP rate limiting**
- **Graceful shutdown** with drain timeout
- **stdio lifecycle hardening** (parent watchdog, idle timeout, boot timeout)
- **Centralized env-driven config** with sensible defaults

---

## Files

```
cli2mcp-gateway/
├── src/
│   ├── server.mjs      # dual-transport entry + HTTP server
│   └── help-parser.js  # argparse-style --help → JSON Schema inference
├── .env.example        # configuration template
├── .gitignore
├── package.json
├── README.md
└── LICENSE
```

The CLI runs in whatever directory you point it at via `CLI_CWD` — no `sandbox/` is created by default. Create that path yourself if you want a sandboxed workspace.

---

## License

MIT © drtx32
