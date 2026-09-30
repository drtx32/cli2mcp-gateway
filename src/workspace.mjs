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
  lstatSync,
} from "node:fs";
import { stat, readdir, rm } from "node:fs/promises";
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
  let rootStat;
  try {
    rootStat = statSync(root);
  } catch (err) {
    throw new Error(
      `workspace: failed to inspect configured path "${rawPath}" (resolved: ${root}): ${err.message}`,
    );
  }
  if (!rootStat.isDirectory()) {
    throw new Error(
      `workspace: configured path "${rawPath}" (resolved: ${root}) is not a directory`,
    );
  }

  return buildRuntime(root, cfg, toolMode);
}

function buildRuntime(root, cfg, toolMode) {
  return {
    root,
    followSymlinks: cfg.follow_symlinks === true,
    allowHidden: cfg.allow_hidden_files === true,
    maxTotalBytes: numOrPos(cfg.max_total_bytes, DEFAULT_MAX_TOTAL_BYTES),
    maxFileBytes: numOrPos(cfg.max_file_bytes, DEFAULT_MAX_FILE_BYTES),
    maxFiles: numOrPos(cfg.max_files, DEFAULT_MAX_FILES),
    maxReadBytes: Math.min(
      numOrPos(cfg.max_read_bytes, DEFAULT_MAX_READ_BYTES),
      numOrPos(cfg.max_file_bytes, DEFAULT_MAX_FILE_BYTES),
    ),
    maxListEntries: numOrPos(cfg.max_list_entries, DEFAULT_MAX_LIST_ENTRIES),
    // TTL uses numOrZero so an explicit `ttl_seconds: 0` (or any non-negative
    // finite number) is honoured; only undefined / non-finite falls back to
    // the default. Zero means "never expire by age".
    ttlSeconds: numOrZero(cfg.ttl_seconds, DEFAULT_TTL_SECONDS),
    cleanupPolicy: cfg.cleanup_policy || "oldest_first",
    toolMode,
  };
}

function numOrPos(v, dflt) {
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

function numOrZero(v, dflt) {
  return Number.isFinite(v) && v >= 0 ? v : dflt;
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
 * - When `follow_symlinks=false` (the default), every intermediate
 *   symlink along the path is rejected — even in-root ones. Symlink
 *   resolution only happens when the operator explicitly opted in via
 *   `follow_symlinks: true`. The deeper realpath check below catches
 *   every other variant (encoded, joined, symlinked, etc.).
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
  // When the operator has NOT opted in to symlink following, walk the path
  // component-by-component using lstat so any intermediate symlink is
  // detected and rejected before we open the file. With follow_symlinks=true
  // we let realpathSync resolve the full chain and rely on the containment
  // check below to catch escapes.
  if (!runtime.followSymlinks) {
    const components = relative(runtime.root, base).split(sep).filter(Boolean);
    let cursor = runtime.root;
    for (const c of components) {
      const next = `${cursor}${sep}${c}`;
      let st;
      try { st = lstatSync(next); } catch (err) {
        if (err && err.code === "ENOENT") {
          throw new Error(`workspace: path "${target}" does not exist inside workspace`);
        }
        throw new Error(`workspace: cannot resolve "${target}": ${err.message}`);
      }
      if (st.isSymbolicLink()) {
        throw new Error(
          `workspace: path "${target}" traverses a symlink at "${next}". ` +
          `Set workspace.follow_symlinks=true to allow this.`,
        );
      }
      cursor = next;
    }
    // Final containment sanity check (paranoid; relative() + lstat walk
    // above already rules out any escape).
    if (!isInside(cursor, runtime.root)) {
      throw new Error(`workspace: path "${target}" escapes workspace root`);
    }
    const canonical = cursor;
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

// ---------- quota / TTL cleanup ----------
//
// The workspace is a managed cache; it grows as downstream tools save files
// into it. Without an enforcement pass, an upstream CLI could fill the disk
// by repeatedly writing large outputs. Per ELI-398 the gateway must respect
// max_total_bytes, max_files, ttl_seconds, and cleanup_policy. Quotas are
// enforced lazily on every workspace op (read / list / dir) so a long-running
// session stays inside budget without a dedicated timer.

const CLEANUP_POLICIES = new Set(["oldest_first", "largest_first", "none"]);

/**
 * Walk the workspace once, gathering metadata for every regular file, then
 * prune (oldest_first | largest_first) until both file count and total bytes
 * are inside budget. ttl_seconds drops any file whose mtime is older than
 * `now - ttl * 1000`. cleanup_policy=none skips byte / count eviction but
 * still honours ttl_seconds (an explicit "no quota" is not the same as
 * "never delete anything").
 *
 * @returns {Promise<{deleted: number, bytesReclaimed: number}>}
 */
export async function enforceQuotas(runtime, { now = Date.now(), readdirFn = readdir } = {}) {
  if (!runtime.root) return { deleted: 0, bytesReclaimed: 0, permissionErrors: [] };
  // Collect every file under the root. We use lstat so symlinks aren't
  // followed into the budget — a symlink to a 1GB file shouldn't push us
  // over quota, and we don't have a sane way to delete the target anyway.
  const all = [];
  const stack = ["."];
  while (stack.length > 0) {
    const rel = stack.pop();
    const abs = rel === "." ? runtime.root : `${runtime.root}${sep}${rel}`;
    let ents;
    try {
      ents = await readdirFn(abs, { withFileTypes: true });
    } catch (err) {
      const code = err?.code || "UNKNOWN";
      const detail = err?.message || String(err);
      throw new Error(
        "workspace: quota traversal failed at \"" + (rel === "." ? "." : rel) +
        "\" (" + code + "): " + detail +
        ". Quota enforcement requires a complete inventory and fails closed on unreadable paths.",
      );
    }
    for (const ent of ents) {
      // Visibility policy (allow_hidden_files) only affects what the agent
      // sees via list/read/stat — NOT what counts against disk quota. A
      // downstream CLI filling the disk through `.cache/artifact` would
      // otherwise be invisible to enforceQuotas. We walk every entry here.
      const childRel = rel === "." ? ent.name : `${rel}${sep}${ent.name}`;
      const childAbs = `${abs}${sep}${ent.name}`;
      let st;
      try {
        st = lstatSync(childAbs);
      } catch (err) {
        const code = err?.code || "UNKNOWN";
        throw new Error(
          "workspace: quota traversal failed at \"" + childRel + "\" (" + code + "): " +
          (err?.message || String(err)) +
          ". Quota enforcement requires a complete inventory and fails closed on unreadable paths.",
        );
      }
      if (st.isSymbolicLink()) {
        // Treat symlinks as zero-cost metadata; we never delete them via
        // quota logic (the operator opted into them, if at all).
        continue;
      }
      if (st.isDirectory()) {
        stack.push(childRel);
        continue;
      }
      if (st.isFile()) {
        all.push({
          rel: childRel,
          abs: childAbs,
          size: st.size,
          mtime: st.mtimeMs,
        });
      }
    }
  }
  let deleted = 0;
  let bytesReclaimed = 0;
  // The post-eviction total is tracked so per-file eviction can deduct from
  // the same running total the aggregate-bucket pass checks against.
  let totalBytes = all.reduce((a, b) => a + b.size, 0);
  const maxFileBytes = runtime.maxFileBytes;
  // Track which entries have already been evicted by earlier sub-iterations
  // (TTL pass, per-file pass) so the aggregate-bucket pass doesn't double-
  // count the same file as deleted (which would silently stop before the
  // workspace is actually inside budget).
  const evictedAbs = new Set();
  // 1) TTL pass — drop anything older than ttl_seconds, regardless of policy.
  if (runtime.ttlSeconds > 0) {
    const cutoff = now - runtime.ttlSeconds * 1000;
    for (const f of all) {
      if (f.mtime < cutoff) {
        try {
          await rm(f.abs, { force: true });
          deleted++; bytesReclaimed += f.size; totalBytes -= f.size;
          evictedAbs.add(f.abs);
        } catch {}
      }
    }
    if (deleted > 0) {
      // Rebuild after TTL deletion so the eviction pass below sees fresh state.
      return enforceQuotas(runtime, { now, readdirFn }).then(r => ({
        deleted: r.deleted + deleted,
        bytesReclaimed: r.bytesReclaimed + bytesReclaimed,
        permissionErrors: [],
      }));
    }
  }
  // 2) Per-file cap — drop any single file larger than maxFileBytes. A
  //    downstream CLI can otherwise plant an arbitrarily large artifact that
  //    passes the aggregate-bucket check (e.g. one 500 MiB file inside a 1 GiB
  //    total budget) yet violates the documented per-file limit. Run this
  //    before the aggregate-bucket pass so the post-eviction totals reflect
  //    the per-file eviction.
  if (Number.isFinite(maxFileBytes) && maxFileBytes > 0) {
    for (const f of all) {
      if (f.size > maxFileBytes) {
        try {
          await rm(f.abs, { force: true });
          deleted++; bytesReclaimed += f.size; totalBytes -= f.size;
          evictedAbs.add(f.abs);
        } catch {}
      }
    }
  }
  // 3) Quota pass — only when cleanup_policy != "none". Filter out entries
  //    that the TTL or per-file passes already removed so we don't try to
  //    rm a non-existent path AND double-count its bytes against the
  //    running total.
  if (CLEANUP_POLICIES.has(runtime.cleanupPolicy) && runtime.cleanupPolicy !== "none") {
    const remaining = all.filter(f => !evictedAbs.has(f.abs));
    const sorted = [...remaining].sort((a, b) => {
      if (runtime.cleanupPolicy === "largest_first") return b.size - a.size;
      return a.mtime - b.mtime; // oldest_first
    });
    let remainingFiles = remaining.length;
    for (const f of sorted) {
      if (remainingFiles <= runtime.maxFiles && totalBytes <= runtime.maxTotalBytes) break;
      try {
        await rm(f.abs, { force: true });
        deleted++;
        remainingFiles--;
        bytesReclaimed += f.size;
        totalBytes -= f.size;
      } catch {}
    }
  }
  return { deleted, bytesReclaimed, permissionErrors: [] };
}

/**
 * Read quota metrics without running cleanup. Useful for `dir` so agents can
 * see how full the workspace is.
 *
 * Quota metrics count every file under the root (including hidden ones)
 * because visibility policy and quota policy are different concerns:
 *   - visibility (`allow_hidden_files`) gates list / read / stat
 *   - quota limits the actual disk consumption the workspace is allowed
 *     to take, regardless of whether the agent can see those entries.
 * Skipping hidden files here would let `.cache/artifact` style writes
 * silently inflate the workspace beyond the configured budget.
 */
export async function quotaStats(runtime, { readdirFn = readdir } = {}) {
  const result = { files: 0, totalBytes: 0, maxFiles: runtime.maxFiles, maxTotalBytes: runtime.maxTotalBytes, ttlSeconds: runtime.ttlSeconds, cleanupPolicy: runtime.cleanupPolicy, permissionErrors: [] };
  if (!runtime.root) return result;
  const stack = [runtime.root];
  while (stack.length > 0) {
    const abs = stack.pop();
    let ents;
    try {
      ents = await readdirFn(abs, { withFileTypes: true });
    } catch (err) {
      const relPath = relative(runtime.root, abs) || ".";
      const code = err?.code || "UNKNOWN";
      throw new Error(
        "workspace: quota traversal failed at \"" + relPath + "\" (" + code + "): " +
        (err?.message || String(err)) +
        ". Quota stats require a complete inventory and fail closed on unreadable paths.",
      );
    }
    for (const ent of ents) {
      const childAbs = `${abs}${sep}${ent.name}`;
      let st;
      try {
        st = lstatSync(childAbs);
      } catch (err) {
        const relPath = relative(runtime.root, childAbs) || ".";
        const code = err?.code || "UNKNOWN";
        throw new Error(
          "workspace: quota traversal failed at \"" + relPath + "\" (" + code + "): " +
          (err?.message || String(err)) +
          ". Quota stats require a complete inventory and fail closed on unreadable paths.",
        );
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        stack.push(childAbs);
        continue;
      }
      if (st.isFile()) {
        result.files += 1;
        result.totalBytes += st.size;
      }
    }
  }
  return result;
}

// ---------- ops ----------

/**
 * `workspace.dir` — return the canonical absolute workspace root plus the
 * current quota metrics. The path is what agents should pass to downstream
 * CLI flags like `--output`, `-o`, `--save`, etc. Including the quota state
 * lets the agent see when cleanup will fire next.
 *
 * Runs `enforceQuotas` first so a normal `dir → downstream CLI` workflow
 * actually triggers cleanup even when the caller never invokes `list` or
 * `read`. The metrics reported afterward therefore reflect the post-eviction
 * state, not the pre-call state.
 */
export async function opDir(runtime, { readdirFn = readdir } = {}) {
  await enforceQuotas(runtime, { readdirFn });
  const quotas = await quotaStats(runtime, { readdirFn });
  return { root: runtime.root, quotas };
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
export async function opList(runtime, args, { readdirFn = readdir } = {}) {
  const target = typeof args?.path === "string" && args.path.length > 0 ? args.path : ".";
  const canonical = canonicaliseInsideRoot(target, runtime);
  const recursive = args?.recursive === true;
  // Cleanup before listing so the entry set reflects the post-quota state.
  await enforceQuotas(runtime, { readdirFn });
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
export async function opStat(runtime, args, { readdirFn = readdir } = {}) {
  const target = args?.path;
  if (typeof target !== "string" || target.length === 0) {
    throw new Error("workspace: stat requires a path argument");
  }
  const canonical = canonicaliseInsideRoot(target, runtime);
  await enforceQuotas(runtime, { readdirFn });
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
export async function opRead(runtime, args, { readdirFn = readdir } = {}) {
  const target = args?.path;
  if (typeof target !== "string" || target.length === 0) {
    throw new Error("workspace: read requires a path argument");
  }
  const canonical = canonicaliseInsideRoot(target, runtime);
  const s = await fsStat(canonical);
  if (!s.isFile()) {
    throw new Error(`workspace: read target "${target}" is not a file`);
  }
  // Enforce max_file_bytes (hard cap on a single file's size — even if the
  // operator set max_read_bytes higher) BEFORE max_read_bytes so the more
  // restrictive bound always wins. maxReadBytes is min(max_read_bytes,
  // max_file_bytes) at runtime construction time, so the single check
  // covers both bounds.
  if (s.size > runtime.maxReadBytes) {
    throw new Error(
      `workspace: file "${target}" is ${s.size} bytes, exceeds max_read_bytes ` +
      `(${runtime.maxReadBytes}). Re-run with a smaller file or raise ` +
      `workspace.max_read_bytes / max_file_bytes in box.yaml.`,
    );
  }
  // Opportunistic cleanup before reading — if the workspace is over quota
  // we drop oldest / largest entries so the read sees a coherent view. This
  // keeps a long-running session within budget without a background timer.
  await enforceQuotas(runtime, { readdirFn });
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
export async function callWorkspace(runtime, args, deps = {}) {
  const sub = args?.subcommand;
  if (typeof sub !== "string" || sub.length === 0) {
    throw new Error("workspace: subcommand is required (dir | list | stat | read)");
  }
  switch (sub) {
    case "dir":   return await opDir(runtime, deps);
    case "list":  return await opList(runtime, args, deps);
    case "stat":  return await opStat(runtime, args, deps);
    case "read":  return await opRead(runtime, args, deps);
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
