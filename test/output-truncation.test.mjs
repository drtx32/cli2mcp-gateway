// End-to-end verification of the gateway's content-block forwarding under
// dual_tool_mode.
//
// The `ashare_run` meta-tool in dual_tool_mode is just a CLI subprocess
// wrapper, so any subcommand that returns a giant base64 string in JSON
// would be flattened to text and chopped at the per-service cap.  This
// file covers the workaround: when the CLI is invoked with
// `--output-format mcp`, it prints a single-line MCP envelope that the
// gateway detects, parses, and forwards verbatim — image / audio / binary
// content blocks survive the round-trip without losing bytes.
//
// We exercise this through the real gateway, against a real upstream
// image URL, and assert both the image content block and the legacy
// text-tool path still work.

import test from "node:test";
import assert from "node:assert/strict";
import { callTool } from "./_helpers.mjs";

const REAL_PNG_URL =
  "https://cdn.jiuyangongshe.com/import/44E2B945-125A-4436-ABDA-77AD88880267.png";
const liveTest = process.env.ASHARE_MCP_TEST_TOKEN || process.env.ASHARE_MCP_TEST_ENV_FILE
  ? test
  : test.skip;

liveTest("ashare_run --output-format mcp: image content block round-trips intact", async () => {
  // Pass --format mcp so the CLI emits the envelope; the gateway detects
  // isMcpEnvelope=true and forwards the image content block directly.
  const result = await callTool("ashare_run", {
    commandPath: ["jygs", "industrial-chain-img"],
    args: ["--url", REAL_PNG_URL, "--format", "mcp"],
  });
  const blocks = result.content ?? [];
  assert.equal(blocks.length, 1, `expected 1 content block, got ${blocks.length}`);
  const block = blocks[0];
  assert.equal(block.type, "image", `expected type=image, got ${block.type}`);
  assert.equal(block.mimeType, "image/png");

  const decoded = Buffer.from(block.data ?? "", "base64");
  assert.equal(decoded.length, 265386, "decoded bytes must match image size");
  // PNG magic header
  assert.equal(decoded[0], 0x89);
  assert.equal(decoded[1], 0x50);
  assert.equal(decoded[2], 0x4e);
  assert.equal(decoded[3], 0x47);

  // structuredContent should travel alongside the image block.
  const sc = result.structuredContent;
  assert.ok(sc, "structuredContent should be present alongside the image block");
  assert.equal(sc.width, 895);
  assert.equal(sc.height, 1293);
  assert.equal(sc.size, 265386);
  assert.equal(sc.base64, undefined, "metadata must not duplicate base64");
});

liveTest("ashare_run legacy text path: still works for non-image tools", async () => {
  // industrial-chains returns a DataFrame, --format json yields normal JSON
  // text on stdout — no envelope, gateway should fall through to text path.
  const result = await callTool("ashare_run", {
    commandPath: ["jygs", "industrial-chains"],
    args: ["--format", "json"],
  });
  const blocks = result.content ?? [];
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "text");
  // The text body should be valid JSON (a list of dicts).
  const parsed = JSON.parse(blocks[0].text);
  assert.ok(Array.isArray(parsed) || typeof parsed === "object");
});

liveTest("ashare_help: still resolves under dual_tool_mode", async () => {
  const result = await callTool("ashare_help", {});
  const blocks = result.content ?? [];
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "text");
  assert.ok(blocks[0].text.includes("Help for"), "gateway-injected header missing");
});
