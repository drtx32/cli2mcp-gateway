// Shared helpers for live-end-to-end MCP tests against the running
// `ashare-mcp` gateway on 127.0.0.1:25422.
//
// The gateway uses MCP streamable HTTP, so we must:
//   1. POST initialize, capture the `mcp-session-id` response header.
//   2. Send notifications/initialized (no response expected).
//   3. POST tools/call with the same `mcp-session-id` header.

import { request as httpRequest } from "node:http";
import { existsSync, readFileSync } from "node:fs";

export const mcpPath = "/mcp";

export function bearer() {
  if (process.env.ASHARE_MCP_TEST_TOKEN) return process.env.ASHARE_MCP_TEST_TOKEN;

  const envPath = process.env.ASHARE_MCP_TEST_ENV_FILE || "/etc/cli2mcp/bearer.env";
  if (!existsSync(envPath)) {
    throw new Error(
      "set ASHARE_MCP_TEST_TOKEN or ASHARE_MCP_TEST_ENV_FILE to run live ashare tests",
    );
  }
  const envText = readFileSync(envPath, "utf8");
  const match = envText.match(/^MCP_TOKEN=(.+)$/m);
  if (!match) throw new Error(`MCP_TOKEN not found in ${envPath}`);
  return match[1].trim();
}

let _seq = 0;
function nextId() {
  return ++_seq;
}

// Parse an MCP-over-HTTP response which may be either bare JSON or an
// SSE envelope of the form `event: message\r?\ndata: <json>\r?\n\r?\n`.
export function parseMcpResponse(raw) {
  if (raw === undefined || raw === null) throw new Error("empty MCP response body");
  const trimmed = String(raw).trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  const dataLines = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  for (let i = dataLines.length - 1; i >= 0; i--) {
    const candidate = dataLines[i];
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // fall through
    }
  }
  throw new Error("MCP response had no parseable JSON data line: " + trimmed.slice(0, 200));
}

function postJsonRaw(body, sessionId) {
  return new Promise((resolvePost, rejectPost) => {
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      Authorization: `Bearer ${bearer()}`,
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const req = httpRequest(
      {
        method: "POST",
        host: "127.0.0.1",
        port: 25422,
        path: mcpPath,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolvePost({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on("error", rejectPost);
    req.write(JSON.stringify(body));
    req.end();
  });
}

export async function establishSession() {
  // 1. initialize
  const init = await postJsonRaw(
    {
      jsonrpc: "2.0",
      id: nextId(),
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    },
    null,
  );
  if (init.status !== 200) {
    throw new Error(`initialize HTTP ${init.status}: ${init.body}`);
  }
  const sessionId = init.headers["mcp-session-id"];
  if (!sessionId) {
    throw new Error("initialize response missing mcp-session-id header");
  }
  // 2. notifications/initialized (no body expected)
  await postJsonRaw(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId,
  );
  return sessionId;
}

export async function callTool(name, args) {
  const sessionId = await establishSession();
  const r = await postJsonRaw(
    {
      jsonrpc: "2.0",
      id: nextId(),
      method: "tools/call",
      params: { name, arguments: args || {} },
    },
    sessionId,
  );
  if (r.status >= 400) throw new Error(`HTTP ${r.status}: ${r.body}`);
  const envelope = parseMcpResponse(r.body);
  if (envelope.error) throw new Error(`JSON-RPC error: ${JSON.stringify(envelope.error)}`);
  return envelope.result;
}
