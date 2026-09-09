// E2E regression for the mcp-http tools/call dispatch bug.
//
// server.mjs's tools/call handler used to condition on
// `svc.adapter === "mcp-stdio"` only, so an mcp-http service fell through
// to the CLI execa() path and crashed with
// "Cannot read properties of undefined (reading 'commandPath')".
//
// This test:
//   1. starts an in-memory stub HTTP MCP server
//   2. writes a one-service box.yaml pointing mcp-http at the stub
//   3. spawns `node src/server.mjs serve --config <box> --http` on a
//      fixed port
//   4. hits the gateway with initialize + tools/list + tools/call JSON-RPC
//   5. asserts the upstream echo tool round-trips

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATEWAY_PORT = 31234;

async function postJson(port, path, body, bearer, sessionId) {
  return new Promise((resolvePost, rejectPost) => {
    const req = httpRequest({
      method: "POST",
      host: "127.0.0.1",
      port,
      path,
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        ...(bearer ? { "Authorization": `Bearer ${bearer}` } : {}),
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolvePost({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", rejectPost);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function getHealth(port, bearer) {
  return new Promise((resolveGet, rejectGet) => {
    const req = httpRequest({
      method: "GET",
      host: "127.0.0.1",
      port,
      path: "/health",
      headers: bearer ? { "Authorization": `Bearer ${bearer}` } : {},
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolveGet({ status: res.statusCode, body: data }));
    });
    req.on("error", rejectGet);
    req.end();
  });
}

async function waitForHealth(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await getHealth(port, "test-bearer");
      if (res.status === 200) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`gateway did not become ready on port ${port}`);
}

test("mcp-http service: tools/call round-trips through gateway", async () => {
  // 1. Stub upstream.
  const upstream = createServer(async (req, res) => {
    if (req.method === "GET") { res.writeHead(405).end(); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body || "{}");
    res.setHeader("Content-Type", "application/json");
    if (message.method === "initialize") {
      res.setHeader("mcp-session-id", "stub-session");
      res.setHeader("mcp-protocol-version", "2025-03-26");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "upstream", version: "1" } },
      }));
    } else if (message.method === "notifications/initialized") {
      res.writeHead(202).end();
    } else if (message.method === "tools/list") {
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] },
      }));
    } else if (message.method === "tools/call") {
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "echo:" + message.params.arguments.text }] },
      }));
    } else {
      res.writeHead(400).end();
    }
  });
  await new Promise(resolveUp => upstream.listen(0, "127.0.0.1", resolveUp));
  const upstreamPort = upstream.address().port;

  // 2. Box + temp dir.
  const workdir = mkdtempSync(resolve(tmpdir(), "cli2mcp-mcp-http-"));
  const boxPath = resolve(workdir, "box.yaml");
  writeFileSync(boxPath, [
    "name: stub-box",
    "services:",
    "  upstream:",
    "    adapter: mcp-http",
    `    url: http://127.0.0.1:${upstreamPort}/mcp`,
    "    timeout_ms: 5000",
    "transport:",
    "  type: http",
    "  host: 127.0.0.1",
    `  port: ${GATEWAY_PORT}`,
    "  path: /mcp",
    "auth:",
    "  mode: bearer",
    "  env_var: MCP_TOKEN",
    "naming:",
    "  auto_unwrap_single_service: true",
    "",
  ].join("\n"));

  // 3. Spawn gateway.
  const serverEntry = resolve(projectRoot, "src", "server.mjs");
  const proc = spawn(process.execPath, [serverEntry, "serve", "--config", boxPath, "--http"], {
    env: { ...process.env, MCP_TOKEN: "test-bearer", PORT: String(GATEWAY_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Drain stdio to avoid backpressure.
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", () => {});

  try {
    await waitForHealth(GATEWAY_PORT);

    // 4. initialize.
    const initRes = await postJson(GATEWAY_PORT, "/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    }, "test-bearer");
    if (initRes.status !== 200) {
      throw new Error(`initialize failed: status=${initRes.status} body=${initRes.body}`);
    }
    const sessionId = initRes.headers["mcp-session-id"];
    assert.ok(sessionId, "gateway should return mcp-session-id");

    // 5. tools/list — must include mcp-session-id from initialize.
    const listRes = await postJson(GATEWAY_PORT, "/mcp", {
      jsonrpc: "2.0", id: 2, method: "tools/list",
    }, "test-bearer", sessionId);
    if (listRes.status !== 200) {
      throw new Error(`tools/list failed: status=${listRes.status} body=${listRes.body}`);
    }
    const listData = JSON.parse(listRes.body.split("data: ").pop());
    assert.deepEqual(listData.result.tools.map(t => t.name), ["echo"]);

    // 6. tools/call — the path that previously crashed.
    const callRes = await postJson(GATEWAY_PORT, "/mcp", {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "echo", arguments: { text: "hello" } },
    }, "test-bearer", sessionId);
    assert.equal(callRes.status, 200);
    const callData = JSON.parse(callRes.body.split("data: ").pop());
    assert.equal(callData.result.content[0].text, "echo:hello");
  } finally {
    proc.kill("SIGTERM");
    await new Promise(r => proc.once("exit", r));
    rmSync(workdir, { recursive: true, force: true });
    await new Promise(r => upstream.close(r));
  }
});
