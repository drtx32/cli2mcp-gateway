/**
 * Parse the single-line MCP result envelope emitted by the Multica CLI.
 * Returns null for ordinary CLI output. Malformed envelopes throw a coded error.
 */
export function parseMcpEnvelope(text) {
  const lines = String(text || "").split(/\r?\n/);
  let candidate = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.endsWith("}") || /^\{\s*"isMcpEnvelope"\s*:/.test(line)) candidate = line;
    break;
  }
  if (!candidate) return null;

  const envelopePrefix = /^\{\s*"isMcpEnvelope"\s*:/;
  try {
    const parsed = JSON.parse(candidate);
    if (parsed?.isMcpEnvelope !== true) return null;
    if (!parsed.result || typeof parsed.result !== "object" || Array.isArray(parsed.result)) {
      throw new Error("MCP envelope result must be an object");
    }
    const result = parsed.result;
    if (result.content !== undefined && !Array.isArray(result.content)) {
      throw new Error("MCP envelope content must be an array");
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
  } catch (error) {
    if (envelopePrefix.test(candidate)) {
      const malformed = new Error("Malformed MCP result envelope");
      malformed.code = "invalid_mcp_envelope";
      malformed.cause = error;
      throw malformed;
    }
    return null;
  }
}
