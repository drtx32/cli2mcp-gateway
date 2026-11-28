import { parseMcpEnvelope } from "./mcp-envelope.mjs";

/** Adapt one already-executed CLI stdout value. Never replays the command. */
export function adaptCliResponse({ text, responseMode = "auto", legacyJsonOutput = false, fail }) {
  if (!["auto", "text", "structured", "mcp"].includes(responseMode)) {
    return fail("invalid_response_mode", "responseMode must be auto, text, structured, or mcp.");
  }
  let envelope;
  try {
    envelope = parseMcpEnvelope(text);
  } catch {
    return fail("invalid_mcp_envelope", "Command returned a malformed MCP result envelope.");
  }

  // A complete native envelope takes precedence in every mode so its typed
  // blocks (including images) and error/structured fields remain intact.
  if (envelope) return envelope;

  if (responseMode === "mcp") {
    return fail("mcp_envelope_required", "responseMode=mcp requires one complete native MCP result envelope.");
  }
  if (responseMode === "structured") {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail("invalid_json", "responseMode=structured requires valid JSON stdout.");
    }
    return {
      content: [{ type: "text", text }],
      structuredContent: { data: parsed },
    };
  }
  if (responseMode === "auto" && legacyJsonOutput) {
    try {
      JSON.parse(text);
    } catch {
      return fail("invalid_json", "Command was asked for JSON but returned malformed JSON.");
    }
  }
  return { content: [{ type: "text", text }] };
}
