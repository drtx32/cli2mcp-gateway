import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const node = process.execPath;

test("Gateway executable help explains responseMode belongs to the MCP Gateway", () => {
  const output = execFileSync(node, [resolve(root, "bin/cli2mcp-gateway.cjs"), "--help"], { encoding: "utf8" });
  assert.match(output, /Gateway-only responseMode/);
  assert.match(output, /not a CLI flag/);
  assert.match(output, /_run tool description and input schema/);
  assert.match(output, /wrapped CLI's own --help/);
});

test("foreground server help documents modes, legacy defaults, limits, typed content and safe retries", () => {
  const output = execFileSync(node, [resolve(root, "src/server.mjs"), "--help"], { encoding: "utf8" });
  for (const term of ["responseMode", "auto", "structured", "mcp", "not a CLI flag", "images/audio", "Do not automatically retry", "CLI_MAX_OUTPUT_BYTES", "Request logs"]) {
    assert.ok(output.includes(term), `missing help text: ${term}`);
  }
});
