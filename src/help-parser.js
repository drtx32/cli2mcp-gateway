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
      cwd: process.env.CLI_CWD || process.env.CLI2MCP_CWD || process.cwd(),
    });
    return [r.stdout || "", r.stderr || ""].filter(Boolean).join("\n");
  } catch (err) {
    // Some CLIs exit non-zero on --help; ignore if we got text.
    return err?.stdout || err?.stderr || "";
  }
}

function isCommandSectionHeader(line) {
  return /^(commands|available commands|subcommands):\s*$/i.test(line);
}

export function toolNameForPath(base, commandPath) {
  if (!Array.isArray(commandPath) || commandPath.length === 0) return base;
  if (commandPath.length === 1) return `${base}_${commandPath[0]}`;
  return `${base}_${commandPath.join("__")}`;
}

/**
 * List top-level subcommands from a top-level --help. Looks for the
 * "positional arguments:\n  command\n    <name> ..." block (argparse),
 * the "Commands:" block (commander/cobra), and Typer/Rich-style boxed
 * tables where each subcommand sits on a `│` row inside a `╭─ Commands ─╮`
 * panel. Returns an array of names.
 */
export function parseSubcommandNames(helpText) {
  const lines = helpText.split(/\r?\n/);
  const out = [];
  let inPositional = false;
  let inCommands = false;
  let inRichPanel = false;
  let blockIndent = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const stripped = raw.replace(/\s+$/, "");
    if (/^positional arguments:\s*$/i.test(stripped)) { inPositional = true; inCommands = false; inRichPanel = false; continue; }
    if (isCommandSectionHeader(stripped))             { inCommands   = true; inPositional = false; inRichPanel = false; continue; }

    // Typer / Rich panel: top/bottom borders use box-drawing characters and
    // the panel title sits between the dashes (e.g. `╭─ Commands ─...─╮`).
    // Each subcommand row starts with `│` followed by the command name and
    // a description. Skip the border lines themselves.
    //
    // We ONLY mine subcommand rows from panels whose title contains
    // "Commands". Typer/Rich also emits `╭─ Options ─...╮` and `╭─ Args ─...╮`
    // panels whose continuation rows can leak token names like "json"
    // (from `--format <df|records|json|yaml>`) into the result and trigger
    // runaway recursion — so be strict about the panel kind.
    const richOpenMatch = /^╭─\s*([^─]+?)\s*─/.exec(stripped);
    if (richOpenMatch) {
      const title = richOpenMatch[1].trim().toLowerCase();
      inRichPanel = title === "commands";
      inPositional = false;
      inCommands = false;
      continue;
    }
    if (/^╰─/.test(stripped)) { inRichPanel = false; continue; }
    if (inRichPanel) {
      // In Typer/Rich Commands panels, subcommand rows have the form
      //   `│ name   description...`
      // where name starts exactly one space after the leading `│`. Wrapped
      // description rows (e.g. `│                            Args:`,
      // `│                    DataFrame。`) start many spaces after `│` —
      // never exactly one. So the layout marker `^│ ` (one and only one
      // space) is the reliable discriminator.
      //
      // We also reject anything starting with `*` (Typer's required-flag
      // marker is `│ *  --flag  desc`, never used inside a Commands panel
      // for subcommand names) and anything where the "name" begins with
      // `-` (a flag, not a subcommand).
      const richMatch = /^│( )([^ │][^│]*)/.exec(stripped);
      if (richMatch) {
        const tail = richMatch[2].trimStart();
        const nameMatch = /^([A-Za-z_][\w-]*)\b/.exec(tail);
        if (nameMatch) {
          const name = nameMatch[1];
          if (name !== "command" && !out.includes(name)) out.push(name);
          continue;
        }
      }
      // Continuation rows and any other content inside the panel: ignore.
      continue;
    }

    if (inPositional || inCommands) {
      // Exit block when we hit the next section header (no leading whitespace, ends with ':')
      if (/^\S.*:\s*$/.test(stripped) && !/^positional arguments:/i.test(stripped) && !isCommandSectionHeader(stripped)) {
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
function inferUsagePositionals(helpText, commandPath = []) {
  const usageLine = helpText.split(/\r?\n/).find((line) => /^usage:\s*/i.test(line.trim()));
  if (!usageLine) return [];

  const tokens = usageLine.replace(/^usage:\s*/i, "").trim().split(/\s+/).filter(Boolean);
  let start = -1;
  if (commandPath.length > 0) {
    for (let i = 0; i <= tokens.length - commandPath.length; i++) {
      if (commandPath.every((part, idx) => tokens[i + idx] === part)) {
        start = i + commandPath.length;
        break;
      }
    }
  }

  const remainder = tokens.slice(start >= 0 ? start : 0);
  const positionals = [];
  for (const token of remainder) {
    if (/^\[.*\]$/.test(token) && !/^\[[A-Z][A-Z0-9_]*\.\.\.\]$/.test(token)) {
      // Optional wrappers like [OPTIONS] or [ARGS] are ignored here.
      continue;
    }
    if (/^--?/.test(token)) continue;

    const cleaned = token.replace(/^\[+/, "").replace(/\]+$/, "");
    if (!cleaned) continue;
    if (!/^[A-Z][A-Z0-9_]*(?:\.\.\.)?$/.test(cleaned) && !/^<[^>]+>$/.test(cleaned)) continue;

    positionals.push({
      name: cleaned.replace(/\.\.\.$/, ""),
      description: "",
      variadic: /\.\.\.$/.test(cleaned),
    });
  }
  return positionals;
}

export function parseSubcommandSchema(helpText, commandPath = []) {
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
    if (/^(options|flags):\s*$/i.test(stripped))      { flush(); section = "options"; continue; }
    // Exit when next section starts
    if (section && /^[A-Z][A-Za-z][A-Za-z _-]*:\s*$/.test(stripped)
        && !/^positional arguments:/i.test(stripped) && !/^(options|flags):/i.test(stripped)) {
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
      const [spec, ...descParts] = body.split(/\s{2,}/);
      const fragments = spec.split(/\s*,\s*/).filter(Boolean);
      const aliases = [];
      let type = "boolean";
      let choices = null;

      for (const fragment of fragments) {
        const fragMatch = /^(-[A-Za-z]|--[A-Za-z][\w-]*)(?:\s+(\[[^\]]+\]|[A-Z][A-Z0-9_]+|[a-z][\w-]+))?$/.exec(fragment.trim());
        if (!fragMatch) continue;
        const tok = fragMatch[1];
        const hint = fragMatch[2];
        const alias = tok.startsWith("--") ? tok.slice(2) : tok.slice(1);
        aliases.push(alias);
        if (hint) {
          type = "string";
          if (/^\[[^\]]+\]$/.test(hint)) {
            const inner = hint.slice(1, -1);
            if (/^[A-Za-z|]+$/.test(inner)) choices = inner.split("|");
          }
        }
      }

      const canonical = aliases.find((alias) => alias.includes("-"))
        || aliases[aliases.length - 1]
        || null;
      if (!canonical) continue;

      cur = {
        long: canonical,
        short: aliases.find((alias) => alias.length === 1) || null,
        type,
        description: descParts.join(" ").trim(),
        choices,
        repeatable: false,
      };
      if (aliases.length > 1) {
        const aliasList = aliases
          .filter((alias) => alias !== canonical)
          .map((alias) => (alias.length === 1 ? `-${alias}` : `--${alias}`))
          .join(", ");
        if (aliasList) cur.description = `${cur.description ? `${cur.description} ` : ""}(aliases: ${aliasList})`;
      }
      if (!cur.description && fragments.length === 1) {
        cur.description = "";
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

  if (positionals.length === 0) {
    positionals.push(...inferUsagePositionals(helpText, commandPath));
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
 * Run `<cli> --help` (and recursive subcommand --help) and, given an
 * optional list of subcommand names, return an array of MCP tool specs:
 *   [{ name, description, inputSchema, dispatch: { subcommand, shape } }]
 *
 * If `subcommands` is null/empty, falls back to a single tool that wraps the
 * whole CLI (legacy mode).
 *
 * A synthetic `<cli>_help` tool is always prepended. It runs `<cli> [--sub] --help`
 * on demand and returns the raw help text — the agent's primary way to learn
 * what's available without burning output budget on broad enumeration tools.
 *
 * If `options.dualToolMode === true`, no recursive expansion happens. Only
 * `<cli>_help` and `<cli>_run` are exposed — `<cli>_run` lets the agent invoke
 * any subcommand (including nested ones) without per-subcommand MCP tools.
 * Use this for CLIs whose top-level subcommands are just command groupings
 * (e.g. `multica issue create`) and where per-tool schema inference yields
 * empty/incorrect schemas.
 */
export async function discoverTools(baseCmd, subcommands = null, options = {}) {
  const base = baseCmd.replace(/^.*\//, "").replace(/[^A-Za-z0-9_-]/g, "_");
  const captureHelpFn = options.captureHelpFn || captureHelp;
  const dualToolMode = options.dualToolMode === true;
  // When true, only run --help on the top-level CLI and emit one tool per
  // top-level subcommand. Skip the recursive walk into sub-subcommands. Use
  // this for CLIs whose deep help trees are too slow or produce empty
  // schemas (e.g. typer/rich panels that group commands without per-arg
  // detail). Tool calls still get the full <cli> <sub> <sub> argv, so
  // execution works as long as the top-level schema isn't required.
  const skipRecursive = options.skipRecursive === true;
  const topHelp = await captureHelpFn(baseCmd, []);
  const roots = dualToolMode
    ? []
    : (subcommands && subcommands.length > 0
        ? subcommands
        : parseSubcommandNames(topHelp));

  const out = [];

  // Synthetic "help" meta-tool — ALWAYS listed first so the agent sees it before
  // any concrete subcommand tool. Cheap to call, never truncated.
  out.push({
    name: `${base}_help`,
    description:
      "Gateway meta-tool: run the wrapped CLI's --help and return its full text, prefixed with a short usage note. " +
      "Call this first when you need to discover what the CLI offers or what arguments a particular subcommand takes. " +
      "Pass `sub` and `args` to drill down into a subcommand help page instead of calling high-level subcommands blindly.",
    inputSchema: {
      type: "object",
      properties: {
        commandPath: {
          type: "array",
          items: { type: "string" },
          description: "Preferred: full command path to drill into, e.g. ['jygs', 'industrial-chains'].",
        },
        sub: { type: "string", description: "Legacy alias for a single subcommand name. Prefer commandPath." },
        args: { type: "array", items: { type: "string" }, description: "Extra args (e.g. ['--format=json']). Forwarded verbatim." },
      },
      additionalProperties: false,
    },
    dispatch: { kind: "help" },  // marker; server.mjs routes this specially
  });

  if (dualToolMode) {
    // Synthetic "run" meta-tool — mirrors `_help` but executes the command
    // instead of appending --help. Lets the agent reach any subcommand path
    // (including nested ones) that per-tool schema inference couldn't resolve.
    out.push({
      name: `${base}_run`,
      description:
        "Gateway meta-tool: run the wrapped CLI with the given command path and args. " +
        "Use this when no per-subcommand tool is exposed (CLI_DUAL_TOOL_MODE=true) or when you need to invoke a nested subcommand. " +
        "Prefer calling the `_help` tool first to inspect flags/arguments, then pass them via `args`.",
      inputSchema: {
        type: "object",
        properties: {
          commandPath: {
            type: "array",
            items: { type: "string" },
            description: "Command path, e.g. ['issue', 'create']. Empty for top-level.",
          },
          args: {
            type: "array",
            items: { type: "string" },
            description: "Args forwarded verbatim after the command path, e.g. ['--title', 'X', '--output', 'json'].",
          },
          stdin: { type: "string", description: "Optional: piped into the CLI's stdin." },
        },
        additionalProperties: false,
      },
      dispatch: { kind: "run" },  // marker; server.mjs routes this specially
    });
    return out;
  }

  async function walk(commandPath) {
    const helpText = await captureHelpFn(baseCmd, commandPath);
    if (!helpText.trim()) return;
    const subcommands = parseSubcommandNames(helpText);
    if (subcommands.length > 0) {
      // If skipRecursive: emit a single tool for THIS command path that
      // accepts any subcommand as args. Otherwise recurse into each sub.
      if (skipRecursive) {
        const shape = parseSubcommandSchema(helpText, commandPath);
        const firstLine = helpText.split(/\r?\n/).find(l => l.trim() && !l.startsWith("usage:"))
          || `${baseCmd} ${commandPath.join(" ")}`;
        out.push({
          name: toolNameForPath(base, commandPath),
          description: firstLine.trim()
            + ` (skips sub-subcommand discovery; pass any deeper subcommand as args)`,
          inputSchema: toInputSchema(shape),
          dispatch: { commandPath, shape },
        });
        return;
      }
      for (const sub of subcommands) {
        await walk([...commandPath, sub]);
      }
      return;
    }

    const shape = parseSubcommandSchema(helpText, commandPath);
    const firstLine = helpText.split(/\r?\n/).find(l => l.trim() && !l.startsWith("usage:")) || `${baseCmd} ${commandPath.join(" ")}`;
    out.push({
      name: toolNameForPath(base, commandPath),
      description: firstLine.trim() + (commandPath.length > 0
        ? ` Use the help tool with commandPath=[${commandPath.map(v => JSON.stringify(v)).join(", ")}] for the full schema.`
        : " Use the help tool for the full schema."),
      inputSchema: toInputSchema(shape),
      dispatch: { commandPath, shape },
    });
  }

  if (roots.length === 0) {
    // No subcommands: treat the whole CLI as one tool.
    const shape = parseSubcommandSchema(topHelp, []);
    out.push({
      name: base,
      description: (topHelp.split("\n")[0] || `Wraps ${baseCmd}`) + " Use the help tool for the full schema.",
      inputSchema: toInputSchema(shape),
      dispatch: { commandPath: [], shape },
    });
    return out;
  }

  if (skipRecursive) {
    // Fast path: only one --help call (already done) at the top level. Emit
    // one tool per top-level subcommand. No sub-args discovery.
    const subcommands = parseSubcommandNames(topHelp);
    for (const sub of subcommands) {
      const toolName = toolNameForPath(base, [sub]);
      out.push({
        name: toolName,
        description: `${sub} (top-level subcommand of ${baseCmd})`,
        inputSchema: { type: "object", properties: { args: { type: "array", items: { type: "string" } } } },
        dispatch: { commandPath: [sub], shape: { positionals: [], flags: [] } },
      });
    }
    return out;
  }

  for (const root of roots) {
    const commandPath = Array.isArray(root) ? root : [root];
    await walk(commandPath);
  }
  return out;
}
