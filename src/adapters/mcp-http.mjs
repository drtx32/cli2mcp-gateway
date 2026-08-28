// adapters/mcp-http.mjs — Adapter for an upstream Streamable HTTP MCP server.

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Connect to an upstream MCP HTTP endpoint, cache its tools, and expose a
 * small caller facade for the gateway dispatcher.
 *
 * Authentication is intentionally expressed as request headers. This covers
 * bearer tokens and other gateway-to-gateway schemes without making the
 * inbound gateway responsible for an interactive OAuth browser flow. OAuth
 * access tokens can be supplied as Authorization headers by env expansion in
 * box.yaml/env_file.
 */
export async function discoverHttpMcp(cfg) {
  const headers = { ...(cfg.headers || {}) };
  if (cfg.auth?.token && ["bearer", "oauth"].includes(cfg.auth.type)) {
    headers.Authorization = `Bearer ${cfg.auth.token}`;
  }
  const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
    requestInit: {
      headers,
    },
  });
  const client = new McpClient(
    { name: `cli2mcp-gateway-http-bridge/${cfg.name}`, version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  const { tools } = await client.listTools();

  return {
    tools: tools.map(t => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    })),
    client,
    close: () => client.close(),
  };
}
