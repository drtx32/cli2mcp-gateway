// Test fixture: minimal stdio MCP server used by the mcp-stdio adapter test.
// Responds to JSON-RPC over stdio with two tools (echo, double) and a
// proper initialize handshake. Reads one JSON message per line from
// stdin, writes one response per line to stdout. Stays alive until stdin
// closes.
//
// Not a full MCP server — just enough to validate that discoverStdioMcp()
// spawns the process, completes initialize, calls listTools, and round-
// trips a tools/call.

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

// Exit cleanly when stdin closes (parent process ended). Without this,
// `node --test` would hang forever waiting for the fixture process to
// exit after the test that spawned it has already moved on.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handle(req) {
  const { id, method, params } = req;

  if (method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "stub-mcp-server", version: "0.0.1" },
      },
    });
  }
  if (method === "notifications/initialized") {
    // no-op (notification, no response id)
    return;
  }
  if (method === "tools/list") {
    return send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echoes back its argument",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
          {
            name: "double",
            description: "Doubles a number",
            inputSchema: {
              type: "object",
              properties: { n: { type: "number" } },
              required: ["n"],
            },
          },
        ],
      },
    });
  }
  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    if (name === "echo") {
      return send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: String(args.text ?? "") }] },
      });
    }
    if (name === "double") {
      return send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: String(Number(args.n) * 2) }] },
      });
    }
    return send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unknown tool: ${name}` },
    });
  }

  // Unknown method — return a JSON-RPC error.
  return send({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not implemented: ${method}` },
  });
}
