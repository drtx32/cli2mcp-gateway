// Test fixture: stdio MCP upstream "B" for the ELI-467 two-upstream
// aggregation acceptance test.
//
// Deliberately richer than stub-mcp-server.mjs: it advertises a tool whose
// name COLLIDES with upstream A's `ping`, publishes non-trivial inputSchemas
// (nested object / array / enum / defaults) plus tool-level metadata, and
// exposes deliberate failure tools so the test can prove that a broken /
// dead upstream does not take the healthy one down with it.
//
// Line-delimited JSON-RPC over stdio. Exits when stdin closes.

let readBuf = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  readBuf += chunk;
  let idx;
  while ((idx = readBuf.indexOf("\n")) !== -1) {
    const line = readBuf.slice(0, idx).trim();
    readBuf = readBuf.slice(idx + 1);
    if (!line) continue;
    handle(JSON.parse(line));
  }
});

process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const TOOLS = [
  {
    name: "ping",
    title: "Beta Ping",
    description: "Upstream B liveness probe. Shares its name with upstream A on purpose.",
    inputSchema: {
      type: "object",
      properties: { seq: { type: "integer", minimum: 1 } },
      required: ["seq"],
    },
    annotations: { title: "Beta Ping", readOnlyHint: true },
    _meta: { "upstream-origin": "beta" },
  },
  {
    name: "beta_echo",
    title: "Beta Echo",
    description: "Echoes text; returns the full received arguments as structuredContent.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1 },
        repeat: { type: "integer", minimum: 1, maximum: 5, default: 1 },
        tags: { type: "array", items: { type: "string" } },
        nested: {
          type: "object",
          properties: {
            region: { type: "string", enum: ["cn", "us", "eu"] },
            depth: { type: "integer" },
          },
          required: ["region"],
        },
      },
      required: ["text"],
    },
    annotations: { readOnlyHint: false },
    _meta: { "upstream-origin": "beta" },
  },
  {
    name: "beta_report",
    title: "Beta Report",
    description: "Returns text + image + structuredContent so block fidelity can be asserted.",
    inputSchema: {
      type: "object",
      properties: { kind: { type: "string", enum: ["png", "text"] } },
      required: ["kind"],
    },
  },
  {
    name: "beta_boom",
    description: "Always fails with isError=true (a well-formed tool-level failure).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "beta_bad",
    description: "Always fails with a JSON-RPC protocol error.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "beta_hang",
    description: "Accepts the request and never answers, to exercise per-upstream timeout.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "beta_exit",
    description: "Kills the upstream process to simulate a mid-session disconnect.",
    inputSchema: { type: "object", properties: {} },
  },
];

function handle(req) {
  const { id, method, params } = req;

  if (method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "stub-mcp-upstream-b", version: "0.0.2" },
        instructions: "Upstream B of the ELI-467 aggregation fixture.",
      },
    });
  }
  if (method === "notifications/initialized") return;
  if (method === "ping") {
    return send({ jsonrpc: "2.0", id, result: {} });
  }

  if (method === "tools/list") {
    return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  }

  if (method === "tools/call") {
    const { name, arguments: args = {} } = params || {};

    switch (name) {
      case "ping":
        return send({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `pong-from-beta seq=${args.seq}` }],
            structuredContent: { upstream: "beta", seq: args.seq },
          },
        });

      case "beta_echo": {
        const repeat = Math.max(1, Math.min(5, Number(args.repeat ?? 1)));
        const base = String(args.text ?? "");
        const body = (args.uppercase ? base.toUpperCase() : base).repeat(repeat);
        return send({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: body }],
            structuredContent: { received: args },
          },
        });
      }

      case "beta_report":
        return send({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              { type: "text", text: `beta-report:${args.kind}` },
              {
                type: "image",
                mimeType: "image/png",
                // 1x1 transparent PNG, base64. Any non-empty payload is enough
                // to prove the image block survives the gateway hop.
                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
              },
            ],
            structuredContent: { upstream: "beta", kind: args.kind },
          },
        });

      case "beta_boom":
        return send({
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [{ type: "text", text: "beta upstream refused the call" }],
          },
        });

      case "beta_bad":
        return send({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "beta upstream rejected the arguments" },
        });

      case "beta_hang":
        // Deliberately no response.
        return;

      case "beta_exit":
        setTimeout(() => process.exit(7), 5);
        return;

      default:
        return send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unknown tool: ${name}` },
        });
    }
  }

  return send({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not implemented: ${method}` },
  });
}