import test from "node:test";
import assert from "node:assert/strict";
import { parseMcpEnvelope } from "../src/mcp-envelope.mjs";

test("parses a small MCP envelope and preserves all result fields", () => {
  const value = {
    isMcpEnvelope: true,
    result: {
      content: [{ type: "text", text: "技能正文" }],
      structuredContent: { count: 1 },
      isError: false,
    },
  };
  assert.deepEqual(parseMcpEnvelope(JSON.stringify(value)), value.result);
});

test("preserves a large Unicode envelope without applying a text cap", () => {
  const body = "技能正文🌱".repeat(12_000);
  const encoded = JSON.stringify({
    isMcpEnvelope: true,
    result: { content: [{ type: "text", text: body }], structuredContent: { files: 18 } },
  });
  assert.ok(Buffer.byteLength(encoded) > 65_536);
  const result = parseMcpEnvelope(encoded);
  assert.equal(result.content[0].text, body);
  assert.equal(result.content[0].text.length, body.length);
  assert.deepEqual(result.structuredContent, { files: 18 });
});

test("preserves non-text blocks and error state", () => {
  const result = {
    content: [{ type: "image", mimeType: "image/png", data: "AQID" }],
    structuredContent: { reason: "fixture" },
    isError: true,
  };
  assert.deepEqual(parseMcpEnvelope(JSON.stringify({ isMcpEnvelope: true, result })), result);
});

test("ordinary output and non-envelope text remain untouched; malformed envelopes fail", () => {
  assert.equal(parseMcpEnvelope("ordinary CLI output"), null);
  assert.equal(parseMcpEnvelope(`diagnostic\n${JSON.stringify({ isMcpEnvelope: true, result: { content: [] } })}\n`), null);
  assert.throws(() => parseMcpEnvelope('{"isMcpEnvelope":true,"result":'), { code: "invalid_mcp_envelope" });
  assert.throws(() => parseMcpEnvelope(JSON.stringify({ isMcpEnvelope: true, result: { content: "bad" } })), { code: "invalid_mcp_envelope" });
  assert.equal(parseMcpEnvelope(JSON.stringify({ isMcpEnvelope: false, result: { content: [] } })), null);
});

test("requires the whole trimmed stdout to be an envelope and accepts discriminator in any key order", () => {
  const envelope = JSON.stringify({ isMcpEnvelope: true, result: { content: [{ type: "text", text: "ok" }] } });
  const diagnostic = `diagnostic before\n${envelope}\ndiagnostic after`;
  assert.equal(parseMcpEnvelope(`\n  ${envelope}  \n`).content[0].text, "ok");
  assert.equal(parseMcpEnvelope(diagnostic), null);
  const reordered = JSON.stringify({ version: 1, result: { content: [{ type: "text", text: "ordered" }] }, isMcpEnvelope: true });
  assert.equal(parseMcpEnvelope(reordered).content[0].text, "ordered");
  assert.equal(parseMcpEnvelope("  \n  "), null);
  assert.throws(() => parseMcpEnvelope('{"isMcpEnvelope":true,"result":'), { code: "invalid_mcp_envelope" });
});
