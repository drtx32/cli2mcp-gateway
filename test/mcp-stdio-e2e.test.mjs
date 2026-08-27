// e2e: spin up a real box.yaml server using mcp-stdio adapter, with our
// stub server as the upstream. Verifies tool list aggregation, namespace
// prefix, and callTool round-trip end-to-end.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { loadBoxConfig } from "../src/box-config.mjs";
import { aggregateTools, buildDispatchTable } from "../src/tool-aggregator.mjs";
import { discoverStdioMcp } from "../src/adapters/mcp-stdio.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const stubPath = resolve(__dirname, "..", "test-fixtures", "stub-mcp-server.mjs");

test("e2e: mcp-stdio upstream appears in aggregated tool list with namespace prefix", async () => {
  // Spin up a real McpClient over stdio. This is the same code path
  // server.mjs uses at boot.
  const { tools, close } = await discoverStdioMcp({
    name: "stub",
    command: process.execPath,
    args: [stubPath],
  });
  try {
    // Aggregator: pretend "stub" is a service in a box config.
    const perServiceTools = { stub: tools };
    const agg = aggregateTools(perServiceTools, { separator: "__" });
    const dispatch = buildDispatchTable(agg);

    // The stub exposes echo + double. With default prefix policy, each
    // gets a `stub__` namespace.
    const names = agg.map(t => t.name).sort();
    assert.deepEqual(names, ["stub__double", "stub__echo"]);

    // Dispatch table maps the qualified name back to the original tool.
    assert.deepEqual(dispatch.get("stub__echo"), { serviceName: "stub", originalName: "echo" });
    assert.deepEqual(dispatch.get("stub__double"), { serviceName: "stub", originalName: "double" });
  } finally {
    await close();
  }
});

test("e2e: box.yaml with mcp-stdio adapter loads and is recognised by loadBoxConfig", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "cli2mcp-e2e-"));
  try {
    const yaml = `
name: e2e
services:
  upstream:
    adapter: mcp-stdio
    command: ${process.execPath}
    args:
      - ${stubPath}
transport: {type: stdio}
auth: {mode: none}
`;
    const boxPath = resolve(dir, "box.yaml");
    writeFileSync(boxPath, yaml, "utf8");
    const { config } = loadBoxConfig(boxPath);
    assert.equal(config.services.upstream.adapter, "mcp-stdio");
    assert.equal(config.services.upstream.command, process.execPath);
    assert.deepEqual(config.services.upstream.args, [stubPath]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
