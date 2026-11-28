import test from "node:test";
import assert from "node:assert/strict";
import { toolCallInfo, withToolCallInfoLog } from "../src/tool-call-info-log.mjs";

const EXPECTED_CAPABILITIES = [
  "stable_record_id",
  "outcome_state",
  "result_shape_metrics",
  "mcp_is_error",
  "call_tool_handler_jsonrpc_error",
];

async function captureCall(info, handler) {
  const lines = [];
  let value;
  let thrown;
  try {
    value = await withToolCallInfoLog(() => info, handler, (line) => lines.push(line));
  } catch (error) {
    thrown = error;
  }
  assert.equal(lines.length, 1, "one info record is emitted for each call");
  return { record: JSON.parse(lines[0]), line: lines[0], value, thrown };
}

test("logs successful result byte length and command path without arguments", async () => {
  const result = { content: [{ type: "text", text: "你好" }] };
  const { record, line, value, thrown } = await captureCall("skill get", async () => result);

  assert.equal(value, result);
  assert.equal(thrown, undefined);
  assert.equal(record.schema_version, 2);
  assert.equal(record.outcome_state, "known");
  assert.match(record.record_id, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(record, {
    schema_version: 2,
    capabilities: [
      "stable_record_id",
      "outcome_state",
      "result_shape_metrics",
      "mcp_is_error",
      "call_tool_handler_jsonrpc_error",
    ],
    record_id: record.record_id,
    level: "info",
    info: "skill get",
    outcome_state: "known",
    result_bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
    result_keys: ["content"],
    content_count: 1,
    content_types: ["text"],
    text_bytes: Buffer.byteLength("你好", "utf8"),
    has_structured_content: false,
    success: true,
    is_error: false,
    jsonrpc_error: false,
  });
  assert.equal(line.includes("private-argument"), false);
});

test("marks MCP error results unsuccessful and counts their serialized bytes", async () => {
  const result = { content: [{ type: "text", text: "failed" }], isError: true };
  const { record, value, thrown } = await captureCall("skill get", async () => result);

  assert.equal(value, result);
  assert.equal(thrown, undefined);
  assert.equal(record.result_bytes, Buffer.byteLength(JSON.stringify(result), "utf8"));
  assert.equal(record.success, false);
  assert.equal(record.is_error, true);
  assert.equal(record.jsonrpc_error, false);
  assert.equal(record.outcome_state, "known");
  assert.equal(record.info, "skill get");
});

test("logs thrown handler errors as unsuccessful with zero result bytes, then rethrows", async () => {
  const error = new Error("handler failed");
  const { record, thrown } = await captureCall("skill get", async () => { throw error; });

  assert.equal(thrown, error);
  assert.equal(record.level, "info");
  assert.equal(record.info, "skill get");
  assert.equal(record.outcome_state, "known");
  assert.equal(record.result_bytes, 0);
  assert.deepEqual(record.result_keys, []);
  assert.equal(record.content_count, 0);
  assert.deepEqual(record.content_types, []);
  assert.equal(record.text_bytes, 0);
  assert.equal(record.success, false);
  assert.equal(record.is_error, null);
  assert.equal(record.jsonrpc_error, true);
});

test("all outcome paths emit schema v2 with the exact unique capability set", async () => {
  const outcomes = [
    async () => ({ content: [] }),
    async () => ({ content: [], isError: true }),
    async () => { throw new Error("private error message"); },
  ];

  for (const handler of outcomes) {
    const { record } = await captureCall("skill get", handler);
    assert.equal(record.schema_version, 2);
    assert.deepEqual(record.capabilities, EXPECTED_CAPABILITIES);
    assert.equal(new Set(record.capabilities).size, record.capabilities.length);
  }
});

test("record IDs are UUIDs, unique per request, and stable when one log line is redelivered", async () => {
  const first = await captureCall("skill get", async () => ({ content: [] }));
  const second = await captureCall("skill get", async () => ({ content: [] }));
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  assert.match(first.record.record_id, uuidV4);
  assert.match(second.record.record_id, uuidV4);
  assert.notEqual(first.record.record_id, second.record.record_id);

  // The gateway emits a record once; simulate at-least-once delivery by
  // forwarding the exact same serialized line more than once.
  const deliveredLines = [];
  deliveredLines.push(first.line, first.line);
  const deliveredIds = deliveredLines.map((line) => JSON.parse(line).record_id);
  assert.deepEqual(deliveredIds, [first.record.record_id, first.record.record_id]);
});

test("skill_run records the requested dynamic command path, not its tool ID or arguments", async () => {
  const name = "skill_run";
  const tool = { name, dispatch: { kind: "run" } };
  const callArgs = {
    commandPath: ["skill", "get"],
    args: { id: "private-argument" },
  };
  const info = toolCallInfo(name, tool, callArgs);
  const { record, line } = await captureCall(info, async () => ({ content: [] }));

  assert.equal(info, "skill get");
  assert.equal(record.info, "skill get");
  assert.equal(line.includes("skill_run"), false);
  assert.equal(line.includes("private-argument"), false);
});

test("dynamic workspace subcommands and run paths are recorded accurately", () => {
  const run = { dispatch: { kind: "run" } };
  assert.equal(toolCallInfo("skill_run", run, {
    commandPath: ["workspace", "list"],
    args: { path: "/private/path" },
  }), "workspace list");

  const workspaceTool = { dispatch: { kind: "workspace", toolName: "skill_workspace" } };
  assert.equal(toolCallInfo("skill_workspace", workspaceTool, {
    subcommand: "read",
    path: "private.txt",
  }), "workspace read");
});
