import test from "node:test";
import assert from "node:assert/strict";
import { adaptCliResponse } from "../src/response-adapter.mjs";

const fail = (code, message) => ({ isError: true, code, content: [{ type: "text", text: message }] });

test("auto preserves legacy plain text and complete native envelope behavior", () => {
  const plain = adaptCliResponse({ text: "{\"a\":1}", fail });
  assert.deepEqual(plain, { content: [{ type: "text", text: "{\"a\":1}" }] });
  const envelopeText = JSON.stringify({
    isMcpEnvelope: true,
    result: { content: [{ type: "image", mimeType: "image/png", data: "AA==" }], structuredContent: { ok: true } },
  });
  const envelope = adaptCliResponse({ text: envelopeText, responseMode: "auto", fail });
  assert.deepEqual(envelope.content, [{ type: "image", mimeType: "image/png", data: "AA==" }]);
  assert.deepEqual(envelope.structuredContent, { ok: true });
});

test("text explicitly keeps ordinary JSON as text while native envelopes still win", () => {
  const text = '{"content":"business"}';
  assert.deepEqual(adaptCliResponse({ text, responseMode: "text", fail }), {
    content: [{ type: "text", text }],
  });
});

test("structured wraps every JSON value in a stable object and retains exact text", () => {
  for (const value of [{ content: "x", nested: ["🌱"] }, [1, null], "word", 3, true, null]) {
    const text = JSON.stringify(value);
    const result = adaptCliResponse({ text, responseMode: "structured", fail });
    assert.deepEqual(result.content, [{ type: "text", text }]);
    assert.deepEqual(result.structuredContent, { data: value });
  }
  assert.equal(adaptCliResponse({ text: "not json", responseMode: "structured", fail }).code, "invalid_json");
});

test("mcp requires a complete native envelope, and malformed envelope remains an error", () => {
  assert.equal(adaptCliResponse({ text: "plain", responseMode: "mcp", fail }).code, "mcp_envelope_required");
  assert.equal(adaptCliResponse({ text: '{"isMcpEnvelope":true', responseMode: "text", fail }).code, "invalid_mcp_envelope");
});

test("legacy JSON validation applies only in auto mode", () => {
  assert.equal(adaptCliResponse({ text: "bad", responseMode: "auto", legacyJsonOutput: true, fail }).code, "invalid_json");
  assert.deepEqual(adaptCliResponse({ text: "bad", responseMode: "text", legacyJsonOutput: true, fail }), {
    content: [{ type: "text", text: "bad" }],
  });
});

test("unknown response modes fail closed", () => {
  assert.equal(adaptCliResponse({ text: "x", responseMode: "image", fail }).code, "invalid_response_mode");
});
