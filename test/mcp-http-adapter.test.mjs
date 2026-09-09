import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { discoverHttpMcp } from "../src/adapters/mcp-http.mjs";

test("mcp-http adapter: discovers and calls an upstream Streamable HTTP MCP server", async () => {
  const seen = [];
  const server = createServer(async (req, res) => {
    seen.push({ method: req.method, authorization: req.headers.authorization });
    if (req.method === "GET") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body || "{}");
    res.setHeader("Content-Type", "application/json");
    if (message.method === "initialize") {
      res.setHeader("mcp-session-id", "http-stub-session");
      res.setHeader("mcp-protocol-version", "2025-03-26");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "http-stub", version: "1" },
        },
      }));
      return;
    }
    if (message.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    if (message.method === "tools/list") {
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [{
            name: "echo",
            description: "Echo",
            inputSchema: { type: "object", properties: { text: { type: "string" } } },
          }],
        },
      }));
      return;
    }
    if (message.method === "tools/call") {
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: message.params.arguments.text }] },
      }));
      return;
    }
    res.writeHead(400).end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const upstream = await discoverHttpMcp({
      name: "http-stub",
      url: "http://127.0.0.1:" + port + "/mcp",
      headers: { "X-Test-Header": "present" },
      auth: { type: "bearer", token: "upstream-token" },
    });
    try {
      assert.deepEqual(upstream.tools.map(tool => tool.name), ["echo"]);
      const result = await upstream.client.callTool({ name: "echo", arguments: { text: "hello" } });
      assert.equal(result.content[0].text, "hello");
      assert.ok(seen.some(request => request.authorization === "Bearer upstream-token"));
    } finally {
      await upstream.close();
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
