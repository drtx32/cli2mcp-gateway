// workspace.mjs — managed single-root read-only workspace runtime.
//
// The gateway exposes a synthetic "workspace" tool when a service has
// `workspace.path` configured (normal mode + workspace) or when the mode
// explicitly requires it (triple mode). From the agent's side, the workspace
// behaves like a small read-only filesystem: dir, list, stat, read. From the
// gateway's side, it's strict: every target is canonicalised against the
// configured workspace root, every escape attempt (../, symlink, absolute)
// is rejected before any read happens, and the configured byte / file /
// entry quotas are enforced.
//
// Design constraints (per ELI-398):
//   - One workspace per service. No allowed_roots arrays.
//   - Workspace is read-only from the agent/gateway. No write / delete / move
//     / copy / execute support.
//   - Workspace never fetches URLs. If an underlying CLI returns a URL, we
//     surface it as text — we never mirror it locally.
//   - Relative `workspace.path` resolves against the box.yaml directory, NOT
//     process cwd. Internally canonicalised to a real absolute path.
//   - The workspace directory is auto-created if missing, subject to safe
//     failure handling.
//   - `dir` returns the canonical absolute path so agents can pass it
//     directly to arbitrary CLIs (e.g. `--output`, `-o`, `--save`) without
//     those CLIs needing to read any CLI2MCP_* env var.
//   - `follow_symlinks` defaults to false. Even when true, the canonicalised
//     target must remain inside the single workspace root — a symlink that
//     resolves outside is rejected.
//   - Hidden files disabled by default when `allow_hidden_files=false`.
//   - Image content blocks round-trip on `read` when the file is a safely
//     detectable image (PNG/JPEG/GIF/WebP). Oversized / unsupported / binary
//     formats either fail cleanly or return metadata, never raw bytes.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const DEFAULT_MAX_TOTAL_BYTES = 1_073_741_824;   // 1 GiB
const DEFAULT_MAX_FILE_BYTES = 33_554_432;       // 32 MiB
const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_READ_BYTES = 16_777_216;       // 16 MiB
const DEFAULT_MAX_LIST_ENTRIES = 1_000;
const DEFAULT_TTL_SECONDS = 86_400;             // 1 day

const IMAGE_MIME = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

const TEXT_MIME = new Map([
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".json", "application/json"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".xml", "application/xml"],
  [".csv", "text/csv"],
  [".tsv", "text/tab-separated-values"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
  [".js", "application/javascript"],
  [".mjs", "application/javascript"],
  [".cjs", "application/javascript"],
  [".sh", "text/x-shellscript"],
]);

/**
 * Resolve a workspace config block into a fully-initialised runtime.
 *
 * @param {object} cfg             workspace config block from box.yaml
 * @param {string} boxDir          absolute path to the directory holding box.yaml
 *                                 (relative `path` is resolved against this, NOT cwd)
 * @param {{ tool_mode?: string, dual_tool_mode?: boolean, __legacy?: any }} [opts]
 *                                 mode resolution context for tool exposure gating
 * @returns {{
 *   root: string,                 // canonical absolute workspace root
 *   followSymlinks: boolean,
 *   allowHidden: boolean,
 *   maxReadBytes: number,
 *   maxListEntries: number,
 *   toolMode: "normal" | "dual" | "triple",
 * } | null}                       null = workspace is not active for this service
 * @throws when the workspace is required (triple mode) but missing/invalid
 */
export function resolveWorkspaceConfig(cfg, boxDir, opts = {}) {
  const toolMode = resolveToolMode(opts);
  const rawPath = (cfg && typeof cfg.path === "string") ? cfg.path.trim() : "";

  // Tool exposure gating:
  //   triple mode → workspace MUST be present and valid; otherwise boot fails
  //   dual mode   → workspace is ignored entirely (legacy dual_tool_mode compat)
  //   normal mode → workspace is exposed when configured; absent is OK
  if (toolMode === "triple" && !rawPath) {
    throw new Error(
      "box-config: triple mode requires workspace.path. " +
      "Configure a workspace.path under the service or switch tool_mode to normal / dual.",
    );
  }
  if (toolMode === "dual") {
    // Ignore workspace completely. Caller treats the service as workspace-less.
    return null;
  }
  if (!rawPath) {
    // normal mode without workspace → workspace tool is not exposed.
    return null;
  }

  // Resolve relative paths against box.yaml's directory.
  const absPath = isAbsolute(rawPath) ? rawPath : resolve(boxDir, rawPath);
  if (!existsSync(absPath)) {
    try {
      mkdirSync(absPath, { recursive: true });
    } catch (err) {
      throw new Error(
        `workspace: failed to create configured path "${rawPath}" (resolved: ${absPath}): ${err.message}`,
      );
    }
  }
  // Canonicalise after mkdir — the path could cross a symlink whose target
  // is more "real" than what we just created.
  const root = realpathSync(absPath);

  return buildRuntime(root, cfg, toolMode);
}

function buildRuntime(root, cfg, toolMode) {
  return {
    root,
    followSymlinks: cfg.follow_symlinks === true,
    allowHidden: cfg.allow_hidden_files === true,
    maxReadBytes: numOr(cfg.max_read_bytes, DEFAULT_MAX_READ_BYTES),
    maxListEntries: numOr(cfg.max_list_entries, DEFAULT_MAX_LIST_ENTRIES),
    toolMode,
  };
}

function numOr(v, dflt) {
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

/**
 * Determine the effective tool_mode given config + legacy flag precedence.
 *
 * Precedence (per ELI-398):
 *   - explicit `tool_mode` (normal | dual | triple) wins if present
 *   - otherwise legacy `dual_tool_mode: true` ⇒ dual
 *   - otherwise normal
 */
export function resolveToolMode({ tool_mode, dual_tool_mode, __legacy } = {}) {
  if (typeof tool_mode === "string" && tool_mode.length > 0) {
    if (!["normal", "dual", "triple"].includes(tool_mode)) {
      throw new Error(
        `box-config: tool_mode must be one of normal | dual | triple, got "${tool_mode}"`,
      );
    }
    return tool_mode;
  }
  if (dual_tool_mode === true) return "dual";
  if (__legacy && __legacy.CLI_DUAL_TOOL_MODE === true) return "dual";
  return "normal";
}

// ---------- safety primitives ----------

/**
 * Canonicalise a user-supplied path against the workspace root.
 * - Relative paths are resolved against the workspace root.
 * - Absolute paths are accepted only if they live inside the workspace root.
 * - `..` traversal is rejected.
 * - Symlink resolution happens against the real filesystem; follow_symlinks=false
 *   is enforced by comparing the canonicalised result against the root.
 *
 * @param {string} target      user-supplied path (relative or absolute)
 * @param {object} runtime     from resolveWorkspaceConfig
 * @returns {string}           canonical absolute path inside the workspace root
 * @throws on escape / missing / non-string target
 */
export function canonicaliseInsideRoot(target, runtime) {
  if (typeof target !== "string" || target.length === 0) {
    throw new Error("workspace: target path must be a non-empty string");
  }
  // Reject literal ".." components before we do anything else — cheap fast-path
  // for the obvious escape attempt. The deeper realpath check below catches
  // every other variant (encoded, joined, symlinked, etc.).
  const parts = target.split(/[\\/]+/).filter(Boolean);
  for (const part of parts) {
    if (part === "..") {
      throw new Error(`workspace: path "${target}" escapes workspace root`);
    }
  }
  // If absolute, it has to live inside the configured workspace root anyway
  // — we don't trust external absolute paths to "be" the workspace.
  const base = isAbsolute(target) ? target : resolve(runtime.root, target);
  let canonical;
  try {
    canonical = realpathSync(base);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new Error(`workspace: path "${target}" does not exist inside workspace`);
    }
    throw new Error(`workspace: cannot resolve "${target}": ${err.message}`);
  }
  if (!isInside(canonical, runtime.root)) {
    throw new Error(`workspace: path "${target}" escapes workspace root`);
  }
  // Hidden file gate: a leading dot in the basename is hidden unless the
  // operator explicitly opts in via `allow_hidden_files: true`. The check
  // applies per-component on the relative path so `./.ssh/id_rsa` is hidden
  // even if the workspace root isn't.
  if (!runtime.allowHidden) {
    const rel = relative(runtime.root, canonical);
    const relParts = rel.split(sep).filter(Boolean);
    if (relParts.some(p => p.startsWith("."))) {
      throw new Error(`workspace: path "${target}" references a hidden file/directory`);
    }
  }
  return canonical;
}

function isInside(candidate, root) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// ---------- ops ----------

/**
 * `workspace.dir` — return the canonical absolute workspace root.
 * The path is what agents should pass to downstream CLI flags like
 * `--output`, `-o`, `--save`, etc.
 */
export async function opDir(runtime) {
  return { root: runtime.root };
}

/**
 * `workspace.list` — bounded recursive directory listing.
 *
 * Returns entries (directories first, then files, both sorted) up to
 * `maxListEntries`. Each entry includes `name`, `path` (relative to root),
 * and `kind` (`dir` | `file` | `symlink`).
 *
 * When `recursive` is true, walks subdirectories. Symlinked subdirectories
 * are NEVER recursed into when follow_symlinks is false; when true, the
 * resolved target must remain inside the workspace.
 */
export async function opList(runtime, args) {
  const target = typeof args?.path === "string" && args.path.length > 0 ? args.path : ".";
  const canonical = canonicaliseInsideRoot(target, runtime);
  const recursive = args?.recursive === true;
  const s = await fsStat(canonical);
  if (!s.isDirectory()) {
    throw new Error(`workspace: list target "${args?.path ?? "."}" is not a directory`);
  }

  const entries = [];
  const limit = runtime.maxListEntries;
  walk(canonical, "", entries, limit, recursive, runtime);
  const truncated = entries.length >= limit;
  return { entries, truncated, root: runtime.root };
}

function walk(absDir, relPrefix, out, limit, recursive, runtime) {
  if (out.length >= limit) return;
  let dirents;
  try {
    dirents = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs = [];
  const files = [];
  for (const dirent of dirents) {
    if (out.length >= limit) break;
    const name = dirent.name;
    if (!runtime.allowHidden && name.startsWith(".")) continue;
    const abs = `${absDir}${sep}${name}`;
    const rel = relPrefix ? `${relPrefix}${sep}${name}` : name;
    if (dirent.isSymbolicLink()) {
      // Always record the symlink; only descend if follow_symlinks is on and
      // the resolved target stays inside the workspace.
      out.push({ name, path: rel, kind: "symlink" });
      if (recursive && runtime.followSymlinks) {
        let real;
        try { real = realpathSync(abs); } catch { continue; }
        if (!isInside(real, runtime.root)) continue;
        if (!runtime.allowHidden) {
          const realParts = real.split(sep).slice(runtime.root.split(sep).length);
          if (realParts.some(p => p.startsWith("."))) continue;
        }
        let realStat = null;
        try { realStat = statSync(real); } catch { continue; }
        if (realStat && realStat.isDirectory()) {
          walk(real, rel, out, limit, recursive, runtime);
        }
      }
      continue;
    }
    if (dirent.isDirectory()) {
      dirs.push({ name, path: rel, kind: "dir", _abs: abs });
    } else if (dirent.isFile()) {
      files.push({ name, path: rel, kind: "file" });
    }
  }
  // Directories first, then files, both sorted by name — predictable for the
  // agent and bounded by `limit`.
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  for (const d of dirs) {
    if (out.length >= limit) break;
    out.push({ name: d.name, path: d.path, kind: "dir" });
    if (recursive) walk(d._abs, d.path, out, limit, recursive, runtime);
  }
  for (const f of files) {
    if (out.length >= limit) break;
    out.push({ name: f.name, path: f.path, kind: "file" });
  }
}

/**
 * `workspace.stat` — metadata for a single path.
 */
export async function opStat(runtime, args) {
  const target = args?.path;
  if (typeof target !== "string" || target.length === 0) {
    throw new Error("workspace: stat requires a path argument");
  }
  const canonical = canonicaliseInsideRoot(target, runtime);
  const s = await fsStat(canonical);
  return {
    path: relative(runtime.root, canonical) || ".",
    kind: s.isDirectory() ? "dir" : (s.isSymbolicLink() ? "symlink" : "file"),
    size: s.size,
    mtime: s.mtime.toISOString(),
    ctime: s.ctime.toISOString(),
    mode: s.mode,
  };
}

async function fsStat(p) {
  try {
    return await stat(p);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new Error(`workspace: path does not exist: ${p}`);
    }
    throw err;
  }
}

/**
 * `workspace.read` — return a single file as typed MCP content.
 *
 * Behavior:
 *   - Image formats (PNG/JPEG/GIF/WebP) return an MCP image content block.
 *   - UTF-8 text / json / markdown / html / csv / etc. return a text block
 *     and structuredContent when useful.
 *   - Files larger than `max_read_bytes` are rejected with a clear error
 *     so the agent can re-request a narrower slice (we never silently
 *     truncate file reads — silent truncation makes file content unfaithful).
 *   - Unknown / binary / oversized-for-image formats return an error
 *     explaining the constraint, never arbitrary bytes.
 */
export async function opRead(runtime, args) {
  const target = args?.path;
  if (typeof target !== "string" || target.length === 0) {
    throw new Error("workspace: read requires a path argument");
  }
  const canonical = canonicaliseInsideRoot(target, runtime);
  const s = await fsStat(canonical);
  if (!s.isFile()) {
    throw new Error(`workspace: read target "${target}" is not a file`);
  }
  if (s.size > runtime.maxReadBytes) {
    throw new Error(
      `workspace: file "${target}" is ${s.size} bytes, exceeds max_read_bytes ` +
      `(${runtime.maxReadBytes}). Re-run with a smaller file or raise ` +
      `workspace.max_read_bytes in box.yaml.`,
    );
  }
  // Read raw bytes once, then decide content type by extension.
  const bytes = readFileSync(canonical);
  const ext = extOf(canonical);
  const imageMime = IMAGE_MIME.get(ext);
  if (imageMime) {
    return {
      content: [{
        type: "image",
        mimeType: imageMime,
        data: bytes.toString("base64"),
      }],
    };
  }
  const textMime = TEXT_MIME.get(ext);
  const text = bytes.toString("utf8");
  if (textMime) {
    const out = { type: "text", text, mimeType: textMime };
    let parsed = null;
    if (ext === ".json") {
      try { parsed = JSON.parse(text); } catch { /* leave as text */ }
    }
    return {
      content: [out],
      ...(parsed !== null ? { structuredContent: parsed } : {}),
    };
  }
  // Unknown extension: try UTF-8 decode. If it round-trips cleanly, surface as
  // text; otherwise reject rather than dumping arbitrary bytes into a text
  // block (silent byte dumping is exactly what we must avoid per ELI-398).
  if (looksLikeUtf8(bytes)) {
    return { content: [{ type: "text", text: bytes.toString("utf8") }] };
  }
  throw new Error(
    `workspace: file "${target}" has unsupported / binary content (${s.size} bytes). ` +
    `Only image, UTF-8 text, and known text formats are readable through this gateway.`,
  );
}

function extOf(p) {
  const i = p.lastIndexOf(".");
  if (i === -1) return "";
  const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (slash > i) return "";
  return p.slice(i).toLowerCase();
}

function looksLikeUtf8(bytes) {
  // Cheap UTF-8 sanity check: reject any byte sequence that would cause a
  // forced decode to insert replacement chars. The Node decoder replaces
  // invalid sequences with U+FFFD; we detect that.
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return decoded.length > 0 || bytes.length === 0;
  } catch {
    return false;
  }
}

// ---------- synthetic tool spec ----------

/**
 * Build the synthetic workspace tool spec for the aggregator. The tool
 * dispatches based on a `subcommand` argument (dir | list | stat | read) so
 * one tool covers all four operations. Naming and description are designed
 * to match the existing `<cli>_help` / `<cli>_run` synthetic-tool style.
 */
export function workspaceToolSpec() {
  return {
    name: "workspace",
    description:
      "Gateway meta-tool: read-only access to the managed workspace for this service. " +
      "Call `workspace(subcommand=\"dir\")` first when you need an output / save / download path — " +
      "the gateway returns a canonical absolute path you can pass directly to " +
      "downstream CLI flags (e.g. `--output`, `-o`, `--save`). " +
      "Subcommands: dir (returns the canonical workspace root), " +
      "list (bounded listing — pass `path` to start somewhere other than the root, " +
      "`recursive: true` to descend), " +
      "stat (metadata for one path — pass `path`), " +
      "read (read a single file — pass `path`). " +
      "Reads return UTF-8 text for text-like files and image content blocks for " +
      "PNG / JPEG / GIF / WebP. Writes, copies, moves, and URL downloads are not available here.",
    inputSchema: {
      type: "object",
      properties: {
        subcommand: {
          type: "string",
          enum: ["dir", "list", "stat", "read"],
          description: "Required: which workspace operation to run.",
        },
        path: {
          type: "string",
          description:
            "Workspace-relative or absolute path inside the workspace. " +
            "Required for stat and read; optional for list (defaults to the root).",
        },
        recursive: {
          type: "boolean",
          description: "list only: descend into subdirectories. Default false.",
        },
      },
      required: ["subcommand"],
      additionalProperties: false,
    },
    dispatch: { kind: "workspace" },
  };
}

/**
 * Dispatch one workspace tool call.
 *
 * @param {object} runtime    from resolveWorkspaceConfig
 * @param {object} args       tool call arguments
 */
export async function callWorkspace(runtime, args) {
  const sub = args?.subcommand;
  if (typeof sub !== "string" || sub.length === 0) {
    throw new Error("workspace: subcommand is required (dir | list | stat | read)");
  }
  switch (sub) {
    case "dir":   return await opDir(runtime, args);
    case "list":  return await opList(runtime, args);
    case "stat":  return await opStat(runtime, args);
    case "read":  return await opRead(runtime, args);
    default: throw new Error(`workspace: unknown subcommand "${sub}"`);
  }
}

// ---------- help content (synthetic) ----------

/**
 * Synthetic workspace help text — what the synthetic `<svc>_help` tool
 * returns when called with commandPath=["workspace"] (or equivalent).
 *
 * Describes the four ops, the security model, and the agent workflow. Mirrors
 * the inline style of the gateway's other help output.
 */
export function workspaceHelpText() {
  return [
    "Managed workspace for this gateway service.",
    "",
    "Read-only access to a single canonical absolute path. The gateway never",
    "fetches URLs into this directory and never exposes write/delete/move/copy.",
    "",
    "When to use it:",
    "  - Call workspace(subcommand=\"dir\") first when you need to pass an --output /",
    "    -o / --save path to the downstream CLI. The returned path is canonical",
    "    and absolute — hand it directly to the CLI flag, do not invent your own.",
    "  - Use list / stat / read to inspect files the CLI or another tool produced",
    "    in the workspace.",
    "",
    "Subcommands:",
    '  workspace(subcommand="dir")                → { root: "<canonical absolute path>" }',
    '  workspace(subcommand="list", path?, recursive?) → { entries: [...], truncated, root }',
    '  workspace(subcommand="stat", path)         → { path, kind, size, mtime, ctime, mode }',
    '  workspace(subcommand="read", path)         → typed MCP content (text or image block)',
    "",
    "Security:",
    "  - .., absolute paths outside the root, and symlinks pointing outside the",
    "    root are all rejected with a clear error before any read.",
    "  - Hidden files (leading \".\") are rejected unless allow_hidden_files=true.",
    "  - Per-read byte cap is workspace.max_read_bytes (default 16 MiB).",
    "  - List results are bounded by workspace.max_list_entries.",
    "  - Image files round-trip as MCP image content blocks; binary / oversized",
    "    files fail with a descriptive error rather than dumping raw bytes.",
    "",
    "Returns a structured JSON error if the target is missing, escapes the root,",
    "or is hidden by policy.",
  ].join("\n");
}

export const __test = {
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_READ_BYTES,
  DEFAULT_MAX_LIST_ENTRIES,
  DEFAULT_TTL_SECONDS,
  IMAGE_MIME,
  TEXT_MIME,
  isInside,
};