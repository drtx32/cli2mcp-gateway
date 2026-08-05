// help-parser.js
//
// Minimal argparse-style help parser. Reads `usage: <cmd> [-h] [-v] [options]` style
// help output and produces a JSON Schema + dispatch metadata suitable for
// exposing as an MCP tool.
//
// Why this exists: the gateway used to wrap the `cli2mcp` npm package which
// did this, but that added a process-hop layer with rough edges on Windows
// (ps1 wrappers + PATH resolution). Inlining the parse keeps everything in
// one Node.js process and gives us per-subcommand tools for free.
//
// Targets argparse (Python), commander.js (Node), and cobra (Go) output styles.
// Anything outside those — we return a permissive schema and let the dispatch
// layer pass everything through.

import { execa } from "execa";

/**
 * Run `<cmd> --help` (or `<cmd> <sub> --help`) and return stdout+stderr.
 * Time out fast — most CLIs answer --help instantly; the 5s guard prevents
 * wedging the gateway if the CLI hangs.
 */
export async function captureHelp(cmd, args = [], timeoutMs = 5_000) {
  const helpArgs = [...args, "--help"];
  try {
    const r = await execa(cmd, helpArgs, {
      timeout: timeoutMs,
      reject: false,
      env: process.env,
      cwd: process.env.CLI2MCP_CWD || process.cwd(),
    });
    return [r.stdout || "", r.stderr || ""].filter(Boolean).join("\n");
  } catch (err) {
    // Some CLIs exit non-zero on --help; ignore if we got text.
    return err?.stdout || err?.stderr || "";
  }
}

/**
 * List top-level subcommands from a top-level --help. Looks for the
 * "positional arguments:\n  command\n    <name> ..." block (argparse)
 * or the "Commands:" block (commander/cobra). Returns an array of names.
 */
export function parseSubcommandNames(helpText) {
  const lines = helpText.split(/\r?\n/);
  const out = [];
  let inPositional = false;
  let inCommands = false;
  let blockIndent = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const stripped = raw.replace(/\s+$/, "");
    if (/^positional arguments:\s*$/i.test(stripped)) { inPositional = true; inCommands = false; continue; }
    if (/^commands:\s*$/i.test(stripped))              { inCommands   = true; inPositional = false; continue; }

    if (inPositional || inCommands) {
      // Exit block when we hit the next section header (no leading whitespace, ends with ':')
      if (/^\S.*:\s*$/.test(stripped) && !/^positional arguments:/i.test(stripped) && !/^commands:/i.test(stripped)) {
        inPositional = false; inCommands = false; continue;
      }
      // Subcommand heading line. Match the first whitespace-separated token at
      // indent ≥ 2 as the name; everything after it is description text.
      const subMatch = /^\s{2,}([A-Za-z_][\w-]*)/.exec(stripped);
      if (subMatch) {
        const name = subMatch[1];
        // argparse writes a placeholder "command" line before the actual
        // subcommands inside the "positional arguments" block — drop it.
        if (name !== "command" && !out.includes(name)) out.push(name);
      }
    }
  }
  return [...new Set(out)];
}

/**
 * Parse one argparse-style block (positional arguments + options).
 * Returns { positionals: [{name, description, variadic}], flags: [{long, short, type, description, choices?, repeatable?}] }
 */
export function parseSubcommandSchema(helpText) {
  const lines = helpText.split(/\r?\n/);
  const positionals = [];
  const flags = [];

  let section = null;          // "positional" | "options"
  let cur = null;              // current flag/positional being read
  let curDescLines = [];

  const flush = () => {
    if (!cur) return;
    const desc = curDescLines.join(" ").replace(/\s+/g, " ").trim();
    if (section === "positional") {
      cur.description = desc;
      positionals.push(cur);
    } else if (section === "options") {
      cur.description = desc;
      flags.push(cur);
    }
    cur = null;
    curDescLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const stripped = raw.replace(/\s+$/, "");

    // Section headers
    if (/^positional arguments:\s*$/i.test(stripped)) { flush(); section = "positional"; continue; }
    if (/^options:\s*$/i.test(stripped))              { flush(); section = "options"; continue; }
    // Exit when next section starts
    if (section && /^[A-Z][A-Za-z][A-Za-z _-]*:\s*$/.test(stripped)
        && !/^positional arguments:/i.test(stripped) && !/^options:/i.test(stripped)) {
      flush(); section = null; continue;
    }

    if (!section) continue;

    // Flag / positional detection.
    // Heuristic: if line starts with whitespace and the first non-whitespace
    // token begins with `-` or `--`, treat as a flag entry. Otherwise, if
    // we're in the positional block, treat as a positional.
    const leadWs = /^\s+/.exec(stripped);
    if (!leadWs) continue;
    const body = stripped.slice(leadWs[0].length);
    if (!body) continue;

    const firstTok = body.split(/\s+/)[0];
    if (/^--?[A-Za-z]/.test(firstTok)) {
      // Flag line. Tokenize, but treat commas as flag separators (argparse
      // writes `-o PATH, --output-dir PATH` on one row).
      flush();
      // Tokenize. Commas AND whitespace separate tokens; we want only the
      // flag / arg-hint tokens, not the separators themselves.
      const tokens = body.split(/[\s,]+/).filter(Boolean);
      const flagGroup = [];
      for (let j = 0; j < tokens.length; j++) {
        const tok = tokens[j];
        const fm = /^(-[A-Za-z]|--[A-Za-z][\w-]*)$/.exec(tok);
        if (!fm) continue;
        // Short-only flags (-h) and long-only flags (--help) both need a stable
        // property name in the JSON Schema. Prefer the long form; fall back
        // to the short form so the client always has a usable key.
        const long = tok.startsWith("--") ? tok.slice(2) : null;
        const short = tok.startsWith("--") ? null : tok.slice(1);
        const propName = long || short;
        const f = {
          long: propName,
          short,
          type: "boolean",
          description: "",
          choices: null,
          repeatable: false,
        };
        // Look ahead for an arg hint. If present, the flag takes a value
        // (string type) and the hint can carry choices / required-info.
        const next = tokens[j + 1];
        if (next && /^[A-Z][A-Z0-9_]+$/.test(next)) {
          // ALL_CAPS = required value (argparse convention)
          f.type = "string";
          j += 1;
        } else if (next && /^[a-z][\w-]+$/.test(next)) {
          // Lowercase hint: still treat as value (commander / cobra convention)
          f.type = "string";
          j += 1;
        } else if (next && /^\[.+\]$/.test(next)) {
          // [CHOICE|OTHER] optional with choices
          f.type = "string";
          const inner = next.slice(1, -1);
          if (/^[A-Za-z|]+$/.test(inner)) f.choices = inner.split("|");
          j += 1;
        }
        flagGroup.push(f);
      }
      cur = flagGroup[0] || null;
      if (flagGroup.length > 1 && cur) {
        cur.description = `(aliases: ${flagGroup.slice(1).map(f => (f.short ? `-${f.short}` : "") + (f.long ? `--${f.long}` : "")).join(", ")}) `;
      }
      continue;
    }

    // Positional line: "  url_or_text        分享链接或包含链接的分享文案"
    if (section === "positional") {
      const posMatch = /^([A-Za-z_][\w-]*)(?:\s+(.+))?\s*$/.exec(body);
      if (posMatch) {
        flush();
        cur = {
          name: posMatch[1],
          description: posMatch[2] || "",
          variadic: /\.\.\./.test(stripped),
        };
        continue;
      }
    }

    // Continuation line for current entry's description (indented further or just text)
    if (cur && /^\s{4,}\S/.test(stripped)) {
      curDescLines.push(stripped.trim());
    } else if (cur && stripped && !/^(\s{2,})(-|--)/.test(stripped)) {
      // Treat as description line if we're in the middle of reading an entry
      // and this isn't a new flag/positional
      curDescLines.push(stripped.trim());
    }
  }
  flush();

  // Heuristic: if only one positional and it's variadic, mark it. If the
  // help shows trailing ellipsis or repetition words, treat as variadic.
  if (positionals.length === 1 && /(\.\.\.|可多个|多个)/.test(positionals[0].description)) {
    positionals[0].variadic = true;
  }

  return { positionals, flags };
}

/**
 * Convert one parsed subcommand shape into a JSON Schema (object, additionalProperties: false).
 */
export function toInputSchema(shape) {
  const properties = {};
  for (const flag of shape.flags) {
    let prop;
    if (flag.type === "boolean") {
      prop = { type: "boolean", description: flag.description };
    } else if (flag.choices) {
      prop = { type: "string", enum: flag.choices, description: flag.description };
    } else {
      prop = { type: "string", description: flag.description };
    }
    properties[flag.long] = prop;
  }
  // Positionals: pack into a single `positional` string array (clients pass them in order)
  if (shape.positionals.length > 0) {
    properties.positional = {
      type: "array",
      items: { type: "string" },
      description: shape.positionals.map(p => `${p.name}${p.variadic ? "..." : ""}: ${p.description}`).join("; "),
    };
  }
  return { type: "object", properties, additionalProperties: false };
}

/**
 * Build argv from a tool call's arguments and the subcommand shape.
 * Pass-through semantics:
 *   - For each defined flag with a truthy / non-empty value, append --flag value.
 *   - For positionals, append the items in order.
 *   - Unknown keys (defensive) are ignored.
 */
export function buildArgv(shape, args) {
  const argv = [];
  for (const flag of shape.flags) {
    if (!(flag.long in args)) continue;
    const v = args[flag.long];
    if (v === undefined || v === null || v === "") continue;
    if (flag.type === "boolean") {
      if (v === true || v === "true") argv.push(`--${flag.long}`);
    } else if (Array.isArray(v)) {
      for (const item of v) argv.push(`--${flag.long}`, String(item));
    } else {
      argv.push(`--${flag.long}`, String(v));
    }
  }
  if (shape.positionals.length > 0 && Array.isArray(args.positional)) {
    for (const p of args.positional) argv.push(String(p));
  }
  return argv;
}

/**
 * Top-level entrypoint: given a base command (e.g. "parsehub") and an
 * optional list of subcommand names, return an array of MCP tool specs:
 *   [{ name, description, inputSchema, dispatch: { subcommand, shape } }]
 *
 * If `subcommands` is null/empty, falls back to a single tool that wraps the
 * whole CLI (legacy mode).
 */
export async function discoverTools(baseCmd, subcommands = null) {
  const topHelp = await captureHelp(baseCmd, []);
  const subs = subcommands && subcommands.length > 0
    ? subcommands
    : parseSubcommandNames(topHelp);

  if (subs.length === 0) {
    // No subcommands: treat the whole CLI as one tool
    const shape = parseSubcommandSchema(topHelp);
    return [{
      name: baseCmd.replace(/^.*\//, "").replace(/[^A-Za-z0-9_-]/g, "_"),
      description: topHelp.split("\n")[0] || `Wraps ${baseCmd}`,
      inputSchema: toInputSchema(shape),
      dispatch: { subcommand: null, shape },
    }];
  }

  // One tool per subcommand
  const out = [];
  for (const sub of subs) {
    const helpText = await captureHelp(baseCmd, [sub]);
    if (!helpText.trim()) continue; // subcommand rejects --help, skip
    const shape = parseSubcommandSchema(helpText);
    const firstLine = helpText.split(/\r?\n/).find(l => l.trim() && !l.startsWith("usage:")) || `${baseCmd} ${sub}`;
    out.push({
      name: `${baseCmd.replace(/^.*\//, "").replace(/[^A-Za-z0-9_-]/g, "_")}_${sub}`,
      description: firstLine.trim(),
      inputSchema: toInputSchema(shape),
      dispatch: { subcommand: sub, shape },
    });
  }
  return out;
}