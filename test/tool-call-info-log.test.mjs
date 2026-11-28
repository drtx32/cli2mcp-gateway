import test from "node:test";
import assert from "node:assert/strict";
import { toolCallInfo, withToolCallInfoLog } from "../src/tool-call-info-log.mjs";

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
  assert.deepEqual(record, {
    level: "info",
    info: "skill get",
    result_bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
    success: true,
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
  assert.equal(record.info, "skill get");
});

test("logs thrown handler errors as unsuccessful with zero result bytes, then rethrows", async () => {
  const error = new Error("handler failed");
  const { record, thrown } = await captureCall("skill get", async () => { throw error; });

  assert.equal(thrown, error);
  assert.deepEqual(record, {
    level: "info",
    info: "skill get",
    result_bytes: 0,
    success: false,
  });
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
