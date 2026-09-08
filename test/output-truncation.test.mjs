// End-to-end verification that:
//   - ashare_run returns the full stdout (no max_output_bytes cap), even
//     when the underlying CLI output exceeds the per-service cap.
//   - ashare_help still applies the cap (help text is metadata, callers
//     use _run to fetch real results).
//
// This regression covers the ChatGPT "image looks broken" symptom where
// the previous behaviour truncated a 350 KB base64 PNG into a 64 KB
// fragment and corrupted the image.

import test from "node:test";
import assert from "node:assert/strict";
import { callTool } from "./_helpers.mjs";

const REAL_PNG_URL =
  "https://cdn.jiuyangongshe.com/import/44E2B945-125A-4436-ABDA-77AD88880267.png";

test("ashare_run: full base64 returned (no max_output_bytes cap)", async () => {
  // 1. Run ashare_run against the jygs industrial-chain-img tool with
  //    a real upstream image.  The image base64 is ~350 KB so it is
  //    well above the per-service 64 KB cap; the response MUST contain
  //    the full payload.
  const result = await callTool("ashare_run", {
    commandPath: ["jygs", "industrial-chain-img"],
    args: ["--url", REAL_PNG_URL, "--format", "json"],
  });

  const text = result.content?.[0]?.text ?? "";
  assert.ok(
    text.length > 65_536,
    `expected > 65536 bytes from ashare_run, got ${text.length}`,
  );
  assert.ok(
    !text.includes("[TRUNCATED:"),
    "ashare_run should NOT contain a TRUNCATED hint",
  );

  // 2. The returned JSON must contain a real, complete base64 PNG.
  const parsed = JSON.parse(text);
  assert.equal(parsed.mime_type, "image/png");
  assert.equal(parsed.width, 895);
  assert.equal(parsed.height, 1293);
  const decoded = Buffer.from(parsed.base64, "base64");
  assert.equal(decoded.length, 265386, "decoded bytes must match image size");
  // PNG magic header
  assert.equal(decoded[0], 0x89);
  assert.equal(decoded[1], 0x50);
  assert.equal(decoded[2], 0x4e);
  assert.equal(decoded[3], 0x47);
});

test("ashare_help: small help output is returned intact (no hint)", async () => {
  // The help text for the top-level ashare CLI is ~3.9 KB, well under
  // the per-service 64 KB cap, so no truncation hint should appear and
  // the gateway's own header should be present.
  const result = await callTool("ashare_help", {});
  const text = result.content?.[0]?.text ?? "";
  assert.ok(text.length > 0, "help returned empty");
  assert.ok(
    text.includes("Help for"),
    "help missing the gateway-injected header",
  );
  assert.ok(
    !text.includes("[TRUNCATED: help was"),
    "small help output should not be truncated",
  );
});

test("ashare_help: deep subcommand help still well under cap", async () => {
  // Drill into a real subcommand help to ensure the help path still
  // resolves and is bounded.
  const result = await callTool("ashare_help", {
    commandPath: ["jygs", "industrial-chain-img"],
  });
  const text = result.content?.[0]?.text ?? "";
  assert.ok(text.includes("industrial-chain-img"), "deep help missing target");
  assert.ok(
    !text.includes("[TRUNCATED: help was"),
    "deep help should be under the cap",
  );
});
