/**
 * Parse an MCP result envelope only when the complete trimmed stdout is one.
 * Any diagnostics or other text around a JSON object are left untouched.
 */
export function parseMcpEnvelope(text) {
  const candidate = String(text ?? "").trim();
  if (!candidate) return null;

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    // A malformed envelope beginning with its discriminator is an explicit
    // protocol error; arbitrary diagnostic output remains ordinary text.
    if (/^\{\s*"isMcpEnvelope"\s*:\s*true\b/.test(candidate)) {
      const malformed = new Error("Malformed MCP result envelope");
      malformed.code = "invalid_mcp_envelope";
      malformed.cause = error;
      throw malformed;
    }
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.isMcpEnvelope !== true) {
    return null;
  }
  if (!parsed.result || typeof parsed.result !== "object" || Array.isArray(parsed.result)) {
    throw invalidEnvelope("MCP envelope result must be an object");
  }
  const result = parsed.result;
  if (result.content !== undefined && !Array.isArray(result.content)) {
    throw invalidEnvelope("MCP envelope content must be an array");
  }
  if (!result.content?.length && result.structuredContent === undefined && !result.isError) {
    return {
      content: [{ type: "text", text: "MCP envelope contained no content; retry with a narrower request." }],
      structuredContent: { error: "empty_mcp_result", recoverable: true },
      isError: true,
    };
  }
  return {
    content: result.content || [],
    ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    isError: Boolean(result.isError),
  };
}

function invalidEnvelope(message) {
  const error = new Error(message);
  error.code = "invalid_mcp_envelope";
  return error;
}
