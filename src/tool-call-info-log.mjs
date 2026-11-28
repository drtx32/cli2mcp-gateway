import { randomUUID } from "node:crypto";

const LOG_SCHEMA_VERSION = 2;
const LOG_CAPABILITIES = Object.freeze([
  "stable_record_id",
  "outcome_state",
  "result_shape_metrics",
  "mcp_is_error",
  "call_tool_handler_jsonrpc_error",
]);

/** Return a safe command path for one tool call, excluding all argument values. */
export function toolCallInfo(name, tool, callArgs = {}) {
  const hint = tool?.dispatch || {};
  let commandParts;
  if (hint.kind === "workspace" && typeof callArgs.subcommand === "string") {
    commandParts = ["workspace", callArgs.subcommand];
  } else if (["help", "run"].includes(hint.kind)
      && Array.isArray(callArgs.commandPath) && callArgs.commandPath.length > 0) {
    commandParts = callArgs.commandPath;
  } else if (["help", "run"].includes(hint.kind)
      && typeof callArgs.sub === "string" && callArgs.sub.length > 0) {
    commandParts = [callArgs.sub];
  } else if (Array.isArray(hint.commandPath) && hint.commandPath.length > 0) {
    commandParts = hint.commandPath;
  } else {
    commandParts = [tool?.originalName || hint.toolName || name || "unknown"];
  }

  return commandParts
    .filter((part) => typeof part === "string")
    .slice(0, 8)
    .map((part) => part.replace(/[\u0000-\u001f\u007f]/g, ""))
    .join(" ")
    .slice(0, 256) || String(name || "unknown").slice(0, 256);
}

function resultSummary(result) {
  const isObject = result !== null && typeof result === "object";
  const keys = isObject ? Object.keys(result).sort() : [];
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const contentTypes = [...new Set(blocks
    .map((block) => block?.type)
    .filter((type) => typeof type === "string"))].sort();
  const textBytes = blocks.reduce((total, block) => (
    block?.type === "text" && typeof block.text === "string"
      ? total + Buffer.byteLength(block.text, "utf8")
      : total
  ), 0);

  return {
    resultKeys: keys,
    contentCount: blocks.length,
    contentTypes,
    textBytes,
    hasStructuredContent: isObject && Object.hasOwn(result, "structuredContent"),
    isError: result?.isError === true,
    resultBytes: Buffer.byteLength(JSON.stringify(result ?? null), "utf8"),
  };
}

function emitRecord(log, record) {
  try {
    log(JSON.stringify(record));
  } catch {
    // Logging must never change the MCP tool result or its error behavior.
  }
}

/** Execute one MCP tool handler and emit its request-level info record. */
export async function withToolCallInfoLog(getInfo, handler, log = console.error) {
  const record = {
    schema_version: LOG_SCHEMA_VERSION,
    capabilities: LOG_CAPABILITIES,
    record_id: randomUUID(),
    level: "info",
    info: "unknown",
    outcome_state: "unknown",
    result_bytes: 0,
    result_keys: [],
    content_count: 0,
    content_types: [],
    text_bytes: 0,
    has_structured_content: false,
    success: null,
    is_error: null,
    jsonrpc_error: null,
  };

  const setInfo = () => {
    try {
      record.info = getInfo();
    } catch {
      record.info = "unknown";
    }
  };

  try {
    const result = await handler();
    record.outcome_state = "incomplete";
    record.success = result?.isError !== true;
    record.is_error = result?.isError === true;
    record.jsonrpc_error = false;
    try {
      const summary = resultSummary(result);
      record.result_bytes = summary.resultBytes;
      record.result_keys = summary.resultKeys;
      record.content_count = summary.contentCount;
      record.content_types = summary.contentTypes;
      record.text_bytes = summary.textBytes;
      record.has_structured_content = summary.hasStructuredContent;
      record.outcome_state = "known";
    } catch {
      // The result was returned, so its outcome is known even if its metrics
      // cannot be serialized or inspected safely.
      record.result_bytes = null;
      record.result_keys = null;
      record.content_count = null;
      record.content_types = null;
      record.text_bytes = null;
      record.has_structured_content = null;
    }
    return result;
  } catch (error) {
    // The MCP Server converts a thrown CallTool handler into a JSON-RPC error
    // response. Keep the exception itself out of logs.
    record.outcome_state = "known";
    record.success = false;
    record.is_error = null;
    record.jsonrpc_error = true;
    throw error;
  } finally {
    setInfo();
    emitRecord(log, record);
  }
}
