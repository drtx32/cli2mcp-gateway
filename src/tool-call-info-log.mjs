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

/** Execute one MCP tool handler and emit its request-level info record. */
export async function withToolCallInfoLog(getInfo, handler, log = console.error) {
  let resultBytes = 0;
  let success = false;
  try {
    const result = await handler();
    resultBytes = Buffer.byteLength(JSON.stringify(result ?? null), "utf8");
    success = result?.isError !== true;
    return result;
  } finally {
    log(JSON.stringify({ level: "info", info: getInfo(), result_bytes: resultBytes, success }));
  }
}
