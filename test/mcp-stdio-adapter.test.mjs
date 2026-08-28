// e2e: mcp-stdio adapter spawns a real stdio MCP server, discovers its
// tools, and round-trips a tools/call. Uses a stub server fixture that
// speaks the minimum JSON-RPC over stdio for initialize, notifications/
// initialized, tools/list, and tools/call.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { discoverStdioMcp, isStdioMcp } from "../src/adapters/mcp-stdio.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const stubPath = resolve(__dirname, "..", "test-fixtures", "stub-mcp-server.mjs");

test("mcp-stdio adapter: discoverStdioMcp returns 2 tools from the stub server", async () => {
  const { tools, client, close } = await discoverStdioMcp({
    name: "test",
    command: process.execPath,  // node
    args: [stubPath],
  });
  try {
    assert.equal(tools.length, 2);
    assert.deepEqual(
      tools.map(t => t.name).sort(),
      ["double", "echo"],
    );
    for (const t of tools) {
      assert.equal(typeof t.description, "string");
      assert.equal(t.inputSchema.type, "object");
    }
  } finally {
    await close();
  }
});

test("mcp-stdio adapter: tools/call round-trips correctly", async () => {
  const { client, close } = await discoverStdioMcp({
    name: "test",
    command: process.execPath,
    args: [stubPath],
  });
  try {
    const echo = await client.callTool({ name: "echo", arguments: { text: "hello" } });
    assert.equal(echo.content[0].type, "text");
    assert.equal(echo.content[0].text, "hello");

    const dbl = await client.callTool({ name: "double", arguments: { n: 21 } });
    assert.equal(dbl.content[0].type, "text");
    assert.equal(dbl.content[0].text, "42");
  } finally {
    await close();
  }
});

test("mcp-stdio adapter: closes cleanly without hanging the process", async () => {
  const { close } = await discoverStdioMcp({
    name: "test",
    command: process.execPath,
    args: [stubPath],
  });
  // close() should resolve; if the child process hangs, this test will time
  // out via node:test's default 30s timeout.
  await close();
});

test("mcp-stdio adapter: auto probe recognises an MCP server", async () => {
  assert.equal(await isStdioMcp({
    name: "probe",
    command: process.execPath,
    args: [stubPath],
  }), true);
});

test("mcp-stdio adapter: auto probe rejects a normal CLI", async () => {
  assert.equal(await isStdioMcp({
    name: "probe",
    command: process.execPath,
    args: ["--help"],
  }, 1000), false);
});
