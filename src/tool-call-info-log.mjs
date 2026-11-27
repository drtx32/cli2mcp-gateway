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
