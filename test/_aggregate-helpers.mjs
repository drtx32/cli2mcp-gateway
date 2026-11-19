// Shared harness for the ELI-467 single-YAML / multi-upstream aggregation
// acceptance tests.
//
// Deliberately secretless and self-contained: every upstream is either an
// in-process loopback HTTP stub or a fixture script spawned over stdio, and
// every listener binds 127.0.0.1 on an ephemeral port. Nothing here reads
// /etc/cli2mcp/*, systemd units, or any production credential.

import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SERVER_ENTRY = resolve(projectRoot, "src", "server.mjs");
export const FIXTURE_B = resolve(projectRoot, "test-fixtures", "stub-mcp-upstream-b.mjs");

// ---------- low-level JSON posting ----------

export function postJson(port, path, body, { token, sessionId, timeoutMs = 15_000 } = {}) {
  return new Promise((res, rej) => {
    const req = httpRequest(
      {
        method: "POST",
        host: "127.0.0.1",
        port,
        path,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        timeout: timeoutMs,
      },
      (r) => {
        let data = "";
        r.setEncoding("utf8");
        r.on("data", (c) => (data += c));
        r.on("end", () => res({ status: r.statusCode, headers: r.headers, body: data }));
      },
    );
    req.on("timeout", () => req.destroy(new Error(`POST ${path} timed out after ${timeoutMs}ms`)));
    req.on("error", rej);
    req.end(JSON.stringify(body));
  });
}

export function getJson(port, path, { token, timeoutMs = 5_000 } = {}) {
  return new Promise((res, rej) => {
    const req = httpRequest(
      {
        method: "GET",
        host: "127.0.0.1",
        port,
        path,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        timeout: timeoutMs,
      },
      (r) => {
        let data = "";
        r.setEncoding("utf8");
        r.on("data", (c) => (data += c));
        r.on("end", () => res({ status: r.statusCode, body: data }));
      },
    );
    req.on("timeout", () => req.destroy(new Error(`GET ${path} timed out`)));
    req.on("error", rej);
    req.end();
  });
}

// The gateway's StreamableHTTPServerTransport answers with an SSE envelope;
// upstream stubs answer with bare JSON. Accept both so one helper serves both
// hops of the test.
export function parseMcpEnvelope(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) throw new Error("empty MCP response body");
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  for (let i = dataLines.length - 1; i >= 0; i--) {
    if (!dataLines[i]) continue;
    try {
      return JSON.parse(dataLines[i]);
    } catch {
      /* keep scanning older frames */
    }
  }
  throw new Error("no parseable JSON frame in: " + trimmed.slice(0, 300));
}

// ---------- downstream MCP client (against the gateway) ----------

/**
 * Minimal MCP streamable-HTTP client. Each call opens its own session so a
 * hung upstream in one test cannot poison unrelated assertions.
 */
export async function withSession(port, { token, path = "/mcp" }, fn) {
  let seq = 0;
  const nextId = () => ++seq;

  const init = await postJson(port, path, {
    jsonrpc: "2.0",
    id: nextId(),
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "eli467-acceptance", version: "1" },
    },
  }, { token });
  if (init.status !== 200) throw new Error(`initialize HTTP ${init.status}: ${init.body}`);
  const sessionId = init.headers["mcp-session-id"];
  if (!sessionId) throw new Error("initialize response missing mcp-session-id header");
  await postJson(port, path, { jsonrpc: "2.0", method: "notifications/initialized" }, { token, sessionId });

  const rpc = async (method, params, opts = {}) => {
    const r = await postJson(port, path, { jsonrpc: "2.0", id: nextId(), method, params },
      { token, sessionId, timeoutMs: opts.timeoutMs });
    if (r.status >= 400) return { httpStatus: r.status, transportError: `HTTP ${r.status}: ${r.body}` };
    const env = parseMcpEnvelope(r.body);
    if (env.error) return { httpStatus: r.status, rpcError: env.error };
    return { httpStatus: r.status, result: env.result };
  };

  return fn({
    sessionId,
    listTools: async (opts) => (await rpc("tools/list", {}, opts)).result,
    callTool: async (name, args = {}, opts = {}) => rpc("tools/call", { name, arguments: args }, opts),
  });
}

// ---------- upstream A: loopback HTTP MCP stub ----------

/**
 * Start a Streamable-HTTP-shaped upstream on an ephemeral loopback port.
 *
 * @param {object} opts
 * @param {Array}  opts.tools       tool specs as advertised by tools/list
 * @param {string} opts.label       echoed into every result so dispatch is provable
 * @param {number} [opts.status]    override the initialize status (e.g. 401)
 * @param {number[]} [opts.failCalls] call indices that should hang instead of answering
 */
export async function startHttpUpstream({ tools, label, status, onCall } = {}) {
  const callLog = [];
  const server = createServer(async (req, res) => {
    if (req.method === "GET" || req.method === "DELETE") return void res.writeHead(405).end();

    let raw = "";
    for await (const chunk of req) raw += chunk;
    let msg;
    try {
      msg = JSON.parse(raw || "{}");
    } catch {
      return void res.writeHead(400).end();
    }

    if (msg.method === "initialize") {
      if (status && status !== 200) {
        res.writeHead(status, { "Content-Type": "application/json" });
        return void res.end(JSON.stringify({
          jsonrpc: "2.0", id: msg.id,
          error: { code: -32001, message: `upstream ${label} refused initialize with ${status}` },
        }));
      }
      res.setHeader("Content-Type", "application/json");
      res.setHeader("mcp-session-id", `${label}-session`);
      res.setHeader("mcp-protocol-version", "2025-06-18");
      return void res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: `upstream-${label}`, version: "1.2.3" },
          instructions: `Upstream ${label} of the ELI-467 fixture.`,
        },
      }));
    }

    if (msg.method === "notifications/initialized") return void res.writeHead(202).end();

    res.setHeader("Content-Type", "application/json");
    const reply = (body) => res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...body }));

    if (msg.method === "tools/list") {
      return void reply({ result: { tools } });
    }

    if (msg.method === "tools/call") {
      const { name, arguments: args = {} } = msg.params || {};
      callLog.push({ name, args });
      if (onCall) {
        const custom = onCall(name, args);
        if (custom === "hang") return;  // never answer
        if (custom) return void reply(custom);
      }
      const tool = tools.find((t) => t.name === name);
      if (!tool) return void reply({ error: { code: -32601, message: `Unknown tool: ${name}` } });
      return void reply({
        result: {
          content: [{ type: "text", text: `${label}:${name}` }],
          structuredContent: { upstream: label, received: args },
        },
      });
    }

    if (msg.method === "ping") return void reply({ result: {} });
    res.writeHead(400).end();
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    callLog,
    close: () => new Promise((r) => server.close(r)),
  };
}

// ---------- gateway lifecycle ----------

/**
 * Spawn `node src/server.mjs serve --config <box> --http` and wait for either
 * readiness or early exit. Returns the exit promise so a test can assert that
 * a bad upcstream actually blocks boot (fail-closed) instead of guessing.
 */
export async function startGateway({ boxPath, port, env = {}, extraArgs = [] }) {
  const proc = spawn(process.execPath, [SERVER_ENTRY, "serve", "--config", boxPath, "--http", ...extraArgs], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs = { stdout: "", stderr: "" };
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (c) => (logs.stdout += c));
  proc.stderr.on("data", (c) => (logs.stderr += c));

  let exitInfo = null;
  const exited = new Promise((r) => proc.once("exit", (code, signal) => {
    exitInfo = { code, signal };
    r(exitInfo);
  }));

  return {
    proc,
    logs,
    exited,
    get exitInfo() { return exitInfo; },
    async waitReady(timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (exitInfo) {
          throw new Error(
            `gateway exited during boot (code=${exitInfo.code} signal=${exitInfo.signal})\n` +
            `--- stderr ---\n${logs.stderr}\n--- stdout ---\n${logs.stdout}`,
          );
        }
        try {
          const h = await getJson(port, "/health");
          if (h.status === 200) return true;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(
        `gateway did not become ready within ${timeoutMs}ms\n` +
        `--- stderr ---\n${logs.stderr}\n--- stdout ---\n${logs.stdout}`,
      );
    },
    async stop() {
      if (exitInfo) return;
      proc.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 4_000))]);
      if (!exitInfo) proc.kill("SIGKILL");
    },
  };
}