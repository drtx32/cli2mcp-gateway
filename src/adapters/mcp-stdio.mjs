// adapters/mcp-stdio.mjs — Adapter that wraps an upstream stdio MCP server.
//
// The adapter owns a long-lived McpClient (1 per upstream). At boot we
// call `client.listTools()` once and cache the resulting ToolSpec[] for
// the tool aggregator. At call time we round-trip `client.callTool()`
// to the upstream.
//
// We deliberately keep this stateless from the gateway's perspective:
// each upstream gets its own client, no global connection pool. The
// MCP SDK's McpClient already handles request/response correlation
// internally (it generates JSON-RPC ids), so we don't need our own.

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Discover the tool list of an upstream stdio MCP server.
 * Returns both the tools (for aggregation) and a closer function (for
 * shutdown).
 *
 * @param {object} cfg
 * @param {string} cfg.name         — service name (used for client identification)
 * @param {string} cfg.command      — upstream executable
 * @param {string[]} [cfg.args]     — upstream CLI args
 * @param {object} [cfg.env]        — env overrides (merged on top of process.env)
 * @param {string} [cfg.cwd]        — upstream working directory
 * @param {number} [cfg.timeoutMs]  — listTools timeout (default 10s)
 * @returns {Promise<{ tools: ToolSpec[], client: McpClient, close: () => Promise<void> }>}
 */
export async function discoverStdioMcp(cfg) {
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args || [],
    env: { ...process.env, ...(cfg.env || {}) },
    cwd: cfg.cwd || process.cwd(),
    stderr: "inherit",  // forward to our stderr; avoids pipe-buffer deadlock
  });
  const client = new McpClient(
    { name: `cli2mcp-gateway-bridge/${cfg.name}`, version: "1.0.0" },
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
