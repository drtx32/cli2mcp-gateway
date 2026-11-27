/**
 * Parse the single-line MCP result envelope emitted by the Multica CLI.
 * Returns null for ordinary CLI output or malformed/non-envelope JSON.
 */
export function parseMcpEnvelope(text) {
  const lines = String(text || "").split(/\r?\n/);
  let candidate = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.endsWith("}")) candidate = line;
    break;
  }
  if (!candidate) return null;

  try {
    const parsed = JSON.parse(candidate);
    if (parsed?.isMcpEnvelope !== true || !parsed.result || typeof parsed.result !== "object") {
      return null;
    }
    const result = parsed.result;
    if (result.content !== undefined && !Array.isArray(result.content)) return null;
    return {
      content: result.content || [],
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      isError: Boolean(result.isError),
    };
  } catch {
    return null;
  }
}
