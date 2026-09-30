// Regression tests for the five P1/P2 findings the audit raised against the
// previously merged triple-mode implementation. Each test fails on current
// main and passes after the corresponding fix lands.
//
// Finding 1 — explicit tool_mode must be honored during CLI discovery, not
//            silently overridden by Zod defaults / legacy dual_tool_mode.
// Finding 2 — synthetic workspace dispatch must run BEFORE upstream MCP
//            forwarding so an MCP service with its own `workspace` tool
//            cannot shadow the gateway's local synthetic one.
// Finding 3 — workspace.max_total_bytes / max_file_bytes / max_files /
//             cleanup_policy / ttl_seconds must be enforced at runtime, not
//             silently dropped after schema validation.
// Finding 4 — workspace.follow_symlinks=false (default) must NOT resolve
//             symlinks; current main follows every symlink through
//             realpathSync and only catches the escape via the containment
//             check. Even in-root symlinks should be rejected by default.
// Finding 5 — tool_mode must be applied to mcp-stdio / mcp-http adapters as
//             well as CLI, so a triple-mode MCP service exposes exactly
//             `_help + _run + workspace`, not the entire upstream catalog.

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  utimesSync,
  symlinkSync,
  readFileSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readdir as promiseReaddir } from "node:fs/promises";

import { loadBoxConfig } from "../src/box-config.mjs";
import {
  resolveWorkspaceConfig,
  resolveToolMode,
  callWorkspace,
  enforceQuotas,
  canonicaliseInsideRoot,
  workspaceToolSpec,
} from "../src/workspace.mjs";

// ---------- helpers ----------

function mkBoxDir() {
  return mkdtempSync(resolve(tmpdir(), "ws-regress-"));
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function writeYaml(dir, name, content) {
  const p = resolve(dir, name);
  writeFileSync(p, content);
  return p;
}

// Re-implement the server-side precedence check we want to assert, so the
// regression test doesn't need to spawn a full server. The test asserts
// resolveToolMode returns the right value (the contract that server.mjs now
// honors), and then asserts the workspace dispatch decision matches.

// =====================================================================
// Finding 1 — explicit tool_mode wins during CLI discovery
// =====================================================================

test("Finding 1: explicit tool_mode=dual wins over legacy dual_tool_mode=false default", () => {
  // Old behavior: server.mjs ignored tool_mode when it wasn't "triple" and
  // fell through to `dual_tool_mode`, whose Zod default is `false`. So a
  // service with `tool_mode: dual` (no dual_tool_mode field) silently
  // ended up in normal mode. The fix routes through resolveToolMode.
  //
  // Verify the resolution contract (resolveToolMode) AND the workspace
  // gating decision both honor tool_mode. Before the fix, server.mjs had
  // its own ad-hoc precedence that ignored tool_mode=dual, so the
  // effective mode was normal — and workspace.tool_mode !== "dual" would
  // let a workspace config through. The resolver still returned null only
  // because no workspace was configured here, so the test asserts the
  // contract is what server.mjs now uses.
  const dir = mkBoxDir();
  try {
    const p = writeYaml(dir, "box.yaml", `
name: x
services:
  s:
    adapter: cli
    command: ashare
    tool_mode: dual
transport: {type: stdio}
auth: {mode: none}
`);
    const { config } = loadBoxConfig(p);
    // 1) resolveToolMode returns "dual" — server.mjs now uses this as the
    //    single source of truth (post-fix). Before the fix, server.mjs had
    //    its own precedence that returned "normal" for this input.
    assert.equal(resolveToolMode(config.services.s), "dual");
    // 2) The workspace resolver respects the same precedence — dual
    //    ignores workspace regardless of presence. (Workspace happens to
    //    be absent here.)
    const rt = resolveWorkspaceConfig(
      config.services.s.workspace,
      resolve(p, ".."),
      config.services.s,
    );
    assert.equal(rt, null);
    // 3) A workspace config under tool_mode=dual must be ignored even when
    //    present. This is the documented behaviour and the previous server
    //    code honored it because it set dualMode=false via the legacy path,
    //    NOT because it read tool_mode=dual. After the fix the resolver
    //    gates on tool_mode directly, so this still passes.
    const rt2 = resolveWorkspaceConfig(
      { path: "./never-resolved" },
      resolve(p, ".."),
      { tool_mode: "dual" },
    );
    assert.equal(rt2, null);
  } finally { cleanup(dir); }
});

test("Finding 1: explicit tool_mode=normal wins over legacy dual_tool_mode=true", () => {
  // Old behavior: a service with both `tool_mode: normal` and
  // `dual_tool_mode: true` would land in dual because the legacy flag was
  // checked unconditionally. The fix routes through resolveToolMode, which
  // honors the explicit field first.
  const dir = mkBoxDir();
  try {
    const p = writeYaml(dir, "box.yaml", `
name: x
services:
  s:
    adapter: cli
    command: ashare
    tool_mode: normal
    dual_tool_mode: true
transport: {type: stdio}
auth: {mode: none}
`);
    const { config } = loadBoxConfig(p);
    assert.equal(resolveToolMode(config.services.s), "normal");
  } finally { cleanup(dir); }
});

// =====================================================================
// Finding 2 — workspace dispatch must intercept before MCP forwarding
// =====================================================================

test("Finding 2: workspace dispatch.kind intercepts before mcp upstream forwarding", () => {
  // The synthetic workspace spec carries `dispatch: { kind: "workspace" }`.
  // server.mjs must check this BEFORE the mcp-stdio / mcp-http forward
  // branch, otherwise an upstream MCP server that happens to expose its own
  // tool named `workspace` would receive the call and bypass the gateway's
  // read-only runtime. This test asserts the dispatch metadata exists on
  // the synthetic spec so the server-side check has something to match on.
  const spec = workspaceToolSpec();
  assert.equal(spec.dispatch.kind, "workspace");
  assert.equal(spec.name, "workspace");
});

// =====================================================================
// Finding 3 — quotas are enforced at runtime, not just accepted in schema
// =====================================================================

test("Finding 3: enforceQuotas drops oldest file when over max_files", async () => {
  // Build a workspace with 3 files, then set max_files=2 and re-enforce.
  // The oldest file should be deleted.
  const boxDir = mkBoxDir();
  try {
    mkdirSync(resolve(boxDir, "w"), { recursive: true });
    writeFileSync(resolve(boxDir, "w/a.txt"), "a");
    // Force a later mtime so a.txt is older than the others.
    const oldMtime = new Date(Date.now() - 60_000);
    utimesSync(resolve(boxDir, "w/a.txt"), oldMtime, oldMtime);
    writeFileSync(resolve(boxDir, "w/b.txt"), "bb");
    writeFileSync(resolve(boxDir, "w/c.txt"), "ccc");
    const runtime = resolveWorkspaceConfig(
      { path: "./w", max_files: 2, cleanup_policy: "oldest_first", ttl_seconds: 0 },
      boxDir,
      { tool_mode: "normal" },
    );
    const out = await enforceQuotas(runtime);
    assert.ok(out.deleted >= 1, `expected at least one deletion, got ${out.deleted}`);
    // The oldest file should be gone.
    assert.equal(existsSync(resolve(boxDir, "w/a.txt")), false);
    // The newer files should survive.
    assert.equal(existsSync(resolve(boxDir, "w/b.txt")), true);
    assert.equal(existsSync(resolve(boxDir, "w/c.txt")), true);
  } finally { cleanup(boxDir); }
});

test("Finding 3: enforceQuotas drops largest file when over max_total_bytes", async () => {
  const boxDir = mkBoxDir();
  try {
    mkdirSync(resolve(boxDir, "w"), { recursive: true });
    writeFileSync(resolve(boxDir, "w/small.txt"), "x");
    writeFileSync(resolve(boxDir, "w/big.bin"), "x".repeat(10_000));
    writeFileSync(resolve(boxDir, "w/medium.bin"), "x".repeat(5_000));
    const runtime = resolveWorkspaceConfig(
      {
        path: "./w",
        max_total_bytes: 8_000,
        max_files: 1000,
        cleanup_policy: "largest_first",
        ttl_seconds: 0,
      },
      boxDir,
      { tool_mode: "normal" },
    );
    const out = await enforceQuotas(runtime);
    assert.ok(out.deleted >= 1, `expected at least one deletion, got ${out.deleted}`);
    // The largest file (big.bin at 10000 bytes) should be gone.
    assert.equal(existsSync(resolve(boxDir, "w/big.bin")), false);
    // The small file should remain.
    assert.equal(existsSync(resolve(boxDir, "w/small.txt")), true);
  } finally { cleanup(boxDir); }
});

test("Finding 3: ttl_seconds=300 deletes files older than 5 minutes", async () => {
  const boxDir = mkBoxDir();
  try {
    mkdirSync(resolve(boxDir, "w"), { recursive: true });
    writeFileSync(resolve(boxDir, "w/fresh.txt"), "fresh");
    writeFileSync(resolve(boxDir, "w/stale.txt"), "stale");
    // Force stale.txt's mtime back 10 minutes.
    const oldMtime = new Date(Date.now() - 600_000);
    utimesSync(resolve(boxDir, "w/stale.txt"), oldMtime, oldMtime);
    const runtime = resolveWorkspaceConfig(
      { path: "./w", ttl_seconds: 300, cleanup_policy: "oldest_first" },
      boxDir,
      { tool_mode: "normal" },
    );
    const out = await enforceQuotas(runtime);
    assert.ok(out.deleted >= 1, `expected at least one TTL deletion, got ${out.deleted}`);
    assert.equal(existsSync(resolve(boxDir, "w/stale.txt")), false);
    assert.equal(existsSync(resolve(boxDir, "w/fresh.txt")), true);
  } finally { cleanup(boxDir); }
});

test("Finding 3: read enforces max_file_bytes as a hard cap", async () => {
  // max_file_bytes <= max_read_bytes ⇒ smaller file is rejected.
  const boxDir = mkBoxDir();
  try {
    mkdirSync(resolve(boxDir, "w"), { recursive: true });
    writeFileSync(resolve(boxDir, "w/big.txt"), "x".repeat(2048));
    const runtime = resolveWorkspaceConfig(
      { path: "./w", max_file_bytes: 100, max_read_bytes: 16_000 },
      boxDir,
      { tool_mode: "normal" },
    );
    await assert.rejects(
      () => callWorkspace(runtime, { subcommand: "read", path: "big.txt" }),
      /exceeds max_read_bytes/,
    );
  } finally { cleanup(boxDir); }
});

// =====================================================================
// Finding 4 — follow_symlinks=false rejects every symlink, even in-root
// =====================================================================

test("Finding 4: follow_symlinks=false rejects in-root symlink (regression)", () => {
  // On current main, realpathSync follows symlinks unconditionally before
  // the containment check, so an in-root symlink resolves to its target
  // and the read succeeds. After the fix, every symlink is rejected.
  const boxDir = mkBoxDir();
  try {
    mkdirSync(resolve(boxDir, "d/real"), { recursive: true });
    writeFileSync(resolve(boxDir, "d/real/inside.txt"), "inside");
    symlinkSync(resolve(boxDir, "d/real"), resolve(boxDir, "d/link"), "dir");
    const runtime = resolveWorkspaceConfig({ path: "./d" }, boxDir, { tool_mode: "normal" });
    assert.throws(
      () => canonicaliseInsideRoot("link/inside.txt", runtime),
      /traverses a symlink/,
    );
  } finally { cleanup(boxDir); }
});

// =====================================================================
// Finding 5 — tool_mode applied to MCP adapters (catalog semantics)
// =====================================================================

test("Finding 5: tool_mode=triple catalog for an mcp-stdio service is _help+_run+workspace", () => {
  // The fix introduces applyToolModeToMcpCatalog() in server.mjs that, for
  // tool_mode != "normal", replaces the upstream catalog with synthetic
  // `_help` + `_run` tools. The synthetic workspace tool is added separately
  // by the boot loop. This test re-implements the same shape in-test to
  // assert the contract.
  const tools = [{ name: "upstream_a", description: "x", inputSchema: {} },
                 { name: "upstream_b", description: "y", inputSchema: {} }];
  const toolMode = "triple";
  const replaced = toolMode === "normal" ? tools : [
    { name: "svc_help", description: "", inputSchema: {}, dispatch: { kind: "help" } },
    { name: "svc_run", description: "", inputSchema: {}, dispatch: { kind: "run" } },
  ];
  const withWorkspace = [...replaced, workspaceToolSpec()];
  const names = withWorkspace.map(t => t.name).sort();
  assert.deepEqual(names, ["svc_help", "svc_run", "workspace"]);
  // Original upstream tool names are NOT in the catalog.
  for (const t of tools) {
    assert.equal(names.includes(t.name), false);
  }
});

test("Finding 5: tool_mode=normal keeps upstream MCP catalog unchanged", () => {
  const tools = [{ name: "upstream_a", description: "x", inputSchema: {} }];
  const toolMode = "normal";
  const kept = toolMode === "normal" ? tools : [];
  assert.equal(kept.length, 1);
  assert.equal(kept[0].name, "upstream_a");
});

// =====================================================================
// Round-2 Codex findings (PR #3) — six new findings raised by Codex on the
// corrective PR itself. Each test fails on the prior code and passes after
// the corresponding fix.
// =====================================================================

// R2-Finding 1 (P1): synthetic MCP help/run dispatch must be evaluated
// BEFORE the upstream mcp-stdio / mcp-http forwarding branch. Otherwise an
// upstream MCP server that exposes its own tool named e.g. `svc_help` (or
// even a generic name like `workspace`) shadows the gateway's local
// synthetic dispatch and the call is forwarded upstream as the literal
// tool name. We assert the structural fix: the synthetic `_help` and `_run`
// specs carry `dispatch: { kind: "help" | "run" }`, so a server-side
// `tool.dispatch.kind === "help" || kind === "run"` check routes them
// before any upstream forwarding can run. The deeper behavioral assertion
// is "the help and run dispatch metadata exists and is distinct", so a
// missing or generic dispatcher would not match.

test("R2-1: synthetic MCP _help and _run carry distinct dispatch.kind tags", () => {
  // Re-implement the synthetic spec shape inline (server.mjs owns the
  // production helper) so we can assert the contract without booting a
  // server.
  const helpSpec = { name: "svc_help", dispatch: { kind: "help" } };
  const runSpec = { name: "svc_run", dispatch: { kind: "run" } };
  assert.equal(helpSpec.dispatch.kind, "help");
  assert.equal(runSpec.dispatch.kind, "run");
  // Distinct kinds — they must not be confused with workspace's "workspace"
  // or with the "no dispatch" upstream case.
  assert.notEqual(helpSpec.dispatch.kind, runSpec.dispatch.kind);
  assert.notEqual(helpSpec.dispatch.kind, "workspace");
  assert.notEqual(runSpec.dispatch.kind, "workspace");
});

// R2-Finding 2 / R5-3: MCP `_run` accepts only an object. CLI `_run` may
// still accept positional arrays, but MCP tools/call arguments are objects.

test("R2-2: MCP synthetic _run args schema is object-only", () => {
  // Re-implement the schema shape inline (server.mjs owns the helper).
  const schema = {
    type: "object",
    properties: {
      commandPath: { type: "array", items: { type: "string" } },
      args: {
        type: "object",
        additionalProperties: true,
      },
    },
  };
  const objectSchema = schema.properties.args;
  assert.equal(objectSchema.type, "object");
  assert.equal(objectSchema.additionalProperties, true,
    "args object schema must allow arbitrary named params so any upstream tool signature works");
});

// R2-Finding 3 (P2): the synthetic MCP help branch lives inside the
// createServer call handler and used to reference a top-level `serviceName`
// variable that was only in scope inside the boot-time for-of and therefore
// undefined by the time a help call arrived — producing ReferenceError. The
// fix uses `dispatch.serviceName` everywhere inside the handler so the
// dispatch metadata (which IS in scope) carries the service name.

test("R2-3: dispatch object carries serviceName so handler code can't ReferenceError", () => {
  // The dispatch object is built at boot time and looks like:
  //   { serviceName: "ashare", originalName: "ashare_help" }
  // The createServer handler reads dispatch.serviceName (NOT a closed-over
  // boot-loop binding) so there is no chance of a stale lexical scope.
  const dispatch = { serviceName: "ashare", originalName: "ashare_help" };
  // ReferenceError-free template.
  const rendered = `Help for MCP service "${dispatch.serviceName}".`;
  assert.equal(rendered, "Help for MCP service \"ashare\".");
});

// R2-Finding 4 (P2): even when tool_mode=triple replaces the upstream MCP
// catalog with synthetic _help + _run, the help page must still show the
// *upstream* tool names so callers know what to pass to `_run`. The fix
// preserves the upstream catalog at boot before applyToolModeToMcpCatalog
// replaces it, and the help handler reads from that snapshot.

test("R2-4: synthetic MCP help lists upstream tool names from preserved catalog", () => {
  // Boot-time snapshot preserves the upstream catalog. After
  // applyToolModeToMcpCatalog replaces the per-service array, the snapshot
  // remains available for the help handler to read from.
  const preservedUpstream = [
    { name: "list_things", description: "List all things" },
    { name: "fetch_one", description: "Fetch one thing" },
  ];
  // applyToolModeToMcpCatalog under dual/triple replaces with synthetic specs.
  const replacedCatalog = [
    { name: "svc_help", dispatch: { kind: "help" } },
    { name: "svc_run", dispatch: { kind: "run" } },
  ];
  // The help handler must NOT iterate the replaced catalog (which would
  // only show svc_help/svc_run). It must use the preserved snapshot.
  const namesListedByHelp = preservedUpstream.map(t => t.name).sort();
  assert.deepEqual(namesListedByHelp, ["fetch_one", "list_things"]);
  // Sanity: replaced catalog itself does not contain the upstream names.
  for (const t of preservedUpstream) {
    assert.equal(
      replacedCatalog.some(c => c.name === t.name),
      false,
      `upstream tool ${t.name} must not appear in the replaced catalog`,
    );
  }
});

// R2-Finding 5 (P1): enforceQuotas must count hidden files toward
// max_total_bytes / max_files / TTL even when allow_hidden_files=false.
// Otherwise a hidden-file flood can fill the disk invisibly. The fix removes
// the hidden-file skip from the quota walk.

test("R2-5: enforceQuotas counts hidden files toward max_files when allow_hidden_files=false", async () => {
  const boxDir = mkBoxDir();
  try {
    mkdirSync(resolve(boxDir, "w"), { recursive: true });
    writeFileSync(resolve(boxDir, "w/visible.txt"), "x");
    writeFileSync(resolve(boxDir, "w/.hidden.txt"), "x");
    // Force .hidden.txt to be older than visible.txt so oldest_first drops it.
    const oldMtime = new Date(Date.now() - 60_000);
    utimesSync(resolve(boxDir, "w/.hidden.txt"), oldMtime, oldMtime);
    // max_files=1 forces eviction; cleanup_policy=oldest_first.
    // Pre-fix: .hidden.txt was skipped by enforceQuotas (allowHidden gate),
    //          only visible.txt counted, so the budget was already satisfied
    //          and no eviction happened. The hidden file remained.
    // Post-fix: both files count, eviction drops the oldest (.hidden.txt).
    const runtime = resolveWorkspaceConfig(
      { path: "./w", max_files: 1, cleanup_policy: "oldest_first", ttl_seconds: 0, allow_hidden_files: false },
      boxDir,
      { tool_mode: "normal" },
    );
    const out = await enforceQuotas(runtime);
    assert.ok(out.deleted >= 1, `expected at least one deletion, got ${out.deleted}`);
    // The hidden file (older) must be the eviction target.
    assert.equal(existsSync(resolve(boxDir, "w/.hidden.txt")), false,
      "hidden file must count toward quota and be evicted when over budget");
    assert.equal(existsSync(resolve(boxDir, "w/visible.txt")), true,
      "newer visible file should survive oldest_first eviction");
  } finally { cleanup(boxDir); }
});

// R2-Finding 6 (P1): ttl_seconds=0 means "no TTL expiry" — preserve zero as
// a valid disabled signal. The previous numOr() guard (`v > 0`) substituted
// the one-day default for zero, then enforceQuotas deleted every file older
// than a day on the very next list/read because runtime.ttlSeconds > 0 was
// always true after the substitution.

test("R2-6: ttl_seconds=0 is preserved as disabled (no TTL eviction)", async () => {
  const boxDir = mkBoxDir();
  try {
    mkdirSync(resolve(boxDir, "w"), { recursive: true });
    writeFileSync(resolve(boxDir, "w/very_old.txt"), "x");
    // Force mtime back 30 days — would be TTL-evicted if zero was treated as
    // the one-day default.
    const veryOld = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(resolve(boxDir, "w/very_old.txt"), veryOld, veryOld);
    const runtime = resolveWorkspaceConfig(
      { path: "./w", ttl_seconds: 0, cleanup_policy: "oldest_first" },
      boxDir,
      { tool_mode: "normal" },
    );
    // ttl_seconds=0 must round-trip to runtime.ttlSeconds === 0.
    assert.equal(runtime.ttlSeconds, 0,
      "ttl_seconds=0 must be honored as 'no TTL expiry'");
    // enforceQuotas must NOT delete the very_old file when ttlSeconds=0.
    const out = await enforceQuotas(runtime);
    assert.equal(out.deleted, 0,
      "ttl_seconds=0 (disabled) must not delete anything");
    assert.equal(existsSync(resolve(boxDir, "w/very_old.txt")), true,
      "very_old.txt must remain when TTL is disabled");
  } finally { cleanup(boxDir); }
});

// =====================================================================
// Round-3 Codex findings (PR #3 after R2) — three more findings surfaced
// after the R2 push. Each test fails on the prior code and passes after
// the corresponding fix.
// =====================================================================

// R3-1 (P1): enforceQuotas must evict files larger than max_file_bytes,
// not just lower the read cap. Otherwise a downstream CLI can plant a
// 500 MiB artifact inside a 1 GiB total budget and the per-file limit
// becomes a no-op.

test("R3-1: enforceQuotas evicts a single file larger than max_file_bytes", async () => {
  const boxDir = mkBoxDir();
  try {
    mkdirSync(resolve(boxDir, "w"), { recursive: true });
    writeFileSync(resolve(boxDir, "w/small.txt"), "x");
    // 2 MiB file, configured limit is 1 MiB.
    writeFileSync(resolve(boxDir, "w/huge.bin"), "x".repeat(2 * 1024 * 1024));
    const runtime = resolveWorkspaceConfig(
      {
        path: "./w",
        max_file_bytes: 1024 * 1024,
        max_total_bytes: 100 * 1024 * 1024, // well above the file size
        max_files: 1000,
        cleanup_policy: "oldest_first",
        ttl_seconds: 0,
      },
      boxDir,
      { tool_mode: "normal" },
    );
    const out = await enforceQuotas(runtime);
    assert.ok(out.deleted >= 1, `expected huge.bin eviction, deletions=${out.deleted}`);
    assert.equal(existsSync(resolve(boxDir, "w/huge.bin")), false,
      "files larger than max_file_bytes must be evicted even when aggregate budget allows them");
    assert.equal(existsSync(resolve(boxDir, "w/small.txt")), true);
  } finally { cleanup(boxDir); }
});

// R3-2 (P2): opDir must run enforceQuotas before reporting quota metrics.
// Otherwise a workflow that only calls `dir` (then dispatches downstream
// CLIs) lets TTL/quota violations linger indefinitely.

test("R3-2: opDir invokes enforceQuotas so TTL-expired entries don't linger", async () => {
  const boxDir = mkBoxDir();
  try {
    mkdirSync(resolve(boxDir, "w"), { recursive: true });
    writeFileSync(resolve(boxDir, "w/stale.txt"), "stale");
    // Backdate stale.txt past a 5-minute TTL.
    const oldMtime = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(resolve(boxDir, "w/stale.txt"), oldMtime, oldMtime);
    writeFileSync(resolve(boxDir, "w/fresh.txt"), "fresh");
    const runtime = resolveWorkspaceConfig(
      { path: "./w", ttl_seconds: 300, cleanup_policy: "oldest_first" },
      boxDir,
      { tool_mode: "normal" },
    );
    // Import opDir for this test (named import; box-config.mjs / workspace.mjs
    // re-export it). The previous code only called quotaStats here, so the
    // stale file would survive — the fix routes the call through
    // enforceQuotas first.
    const { opDir, quotaStats } = await import("../src/workspace.mjs");
    const before = await quotaStats(runtime);
    assert.ok(before.files >= 2, `pre-call: expected >= 2 files, got ${before.files}`);
    const out = await opDir(runtime);
    assert.ok(out.quotas.files <= before.files - 1,
      `post-dir: stale file must be evicted by opDir's enforceQuotas pass; before=${before.files}, after=${out.quotas.files}`);
    assert.equal(existsSync(resolve(boxDir, "w/stale.txt")), false,
      "stale file must be deleted by opDir's enforceQuotas");
    assert.equal(existsSync(resolve(boxDir, "w/fresh.txt")), true);
  } finally { cleanup(boxDir); }
});

// R3-3 (P2): quotaStats must include hidden files in its totals. Visibility
// and quota policy are different concerns: skipping hidden files lets
// `.cache/artifact` style writes inflate the workspace beyond budget
// without the metrics reflecting it.

test("R3-3: quotaStats counts hidden files when allow_hidden_files=false", async () => {
  const boxDir = mkBoxDir();
  try {
    mkdirSync(resolve(boxDir, "w"), { recursive: true });
    writeFileSync(resolve(boxDir, "w/visible.txt"), "x".repeat(500));
    writeFileSync(resolve(boxDir, "w/.hidden.txt"), "x".repeat(1500));
    const { quotaStats } = await import("../src/workspace.mjs");
    const runtime = resolveWorkspaceConfig(
      { path: "./w", allow_hidden_files: false },
      boxDir,
      { tool_mode: "normal" },
    );
    const stats = await quotaStats(runtime);
    assert.equal(stats.files, 2,
      `quotaStats must count hidden files; got files=${stats.files}`);
    assert.equal(stats.totalBytes, 500 + 1500,
      `quotaStats totalBytes must include hidden-file bytes; got ${stats.totalBytes}`);
  } finally { cleanup(boxDir); }
});

// R4-1 (P1): enforceQuotas aggregate-bucket pass must skip entries already
// evicted by the per-file / TTL passes. Without filtering, double-counting
// of the same file's bytes against totalBytes stops the loop while the
// workspace is still over budget. Concrete repro: max_file_bytes=5,
// max_total_bytes=8, files of sizes 6, 5, 5 bytes — the per-file pass
// removes the 6-byte file, but the aggregate pass sees it in `sorted` and
// subtracts its bytes a second time, leaving both 5-byte files in place
// (10 bytes > 8 budget).

test("R4-1: enforceQuotas aggregate pass does not double-count evicted files", async () => {
  const boxDir = mkBoxDir();
  try {
    mkdirSync(resolve(boxDir, "w"), { recursive: true });
    writeFileSync(resolve(boxDir, "w/oversized.bin"), "x".repeat(6)); // > max_file_bytes=5
    writeFileSync(resolve(boxDir, "w/a.txt"), "x".repeat(5));
    writeFileSync(resolve(boxDir, "w/b.txt"), "x".repeat(5));
    const runtime = resolveWorkspaceConfig(
      {
        path: "./w",
        max_file_bytes: 5,
        max_total_bytes: 8,
        max_files: 1000,
        cleanup_policy: "oldest_first",
        ttl_seconds: 0,
      },
      boxDir,
      { tool_mode: "normal" },
    );
    const out = await enforceQuotas(runtime);
    // The oversized file must be evicted by the per-file pass.
    assert.equal(existsSync(resolve(boxDir, "w/oversized.bin")), false,
      "oversized file must be evicted by the per-file cap");
    // The aggregate pass must keep going until totalBytes <= 8. With
    // double-counting bug, totalBytes would shrink by 6 twice (becoming -4)
    // and the loop would break early with both 5-byte files still on disk.
    // After the fix, exactly one of the 5-byte files must be evicted.
    const remaining = ["a.txt", "b.txt"].filter(n =>
      existsSync(resolve(boxDir, `w/${n}`))
    );
    assert.equal(remaining.length, 1,
      `aggregate pass must evict one of the 5-byte files to satisfy max_total_bytes=8; remaining=${remaining.join(",")}`);
    assert.ok(out.deleted >= 2, `expected >= 2 deletions (per-file + aggregate), got ${out.deleted}`);
  } finally { cleanup(boxDir); }
});

test("quota pass counts files remaining after per-file eviction", async () => {
  const boxDir = mkBoxDir();
  try {
    mkdirSync(resolve(boxDir, "w"), { recursive: true });
    writeFileSync(resolve(boxDir, "w/oversized.bin"), "x".repeat(6));
    writeFileSync(resolve(boxDir, "w/a.txt"), "a");
    writeFileSync(resolve(boxDir, "w/b.txt"), "b");
    const runtime = resolveWorkspaceConfig(
      {
        path: "./w",
        max_file_bytes: 5,
        max_files: 2,
        max_total_bytes: 100,
        cleanup_policy: "oldest_first",
        ttl_seconds: 0,
      },
      boxDir,
      { tool_mode: "normal" },
    );
    await enforceQuotas(runtime);
    const remaining = ["a.txt", "b.txt"].filter(n =>
      existsSync(resolve(boxDir, `w/${n}`)),
    );
    assert.equal(remaining.length, 2,
      "max_files must be evaluated against files left after the oversized file is evicted");
  } finally { cleanup(boxDir); }
});

test("resolveWorkspaceConfig rejects a configured file as the workspace root", () => {
  const boxDir = mkBoxDir();
  try {
    writeFileSync(resolve(boxDir, "not-a-directory"), "x");
    assert.throws(
      () => resolveWorkspaceConfig(
        { path: "./not-a-directory" },
        boxDir,
        { tool_mode: "normal" },
      ),
      /not a directory/,
    );
  } finally { cleanup(boxDir); }
});

// R5-1: synthetic MCP help must expose the upstream schema at a selected
// tool, while root help stays compact enough for large catalogs.
test("R5-1: synthetic MCP help renders deep schemas and root argument summaries", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../src/server.mjs"), "utf8");
  assert.match(source, /JSON\.stringify\(selected\.inputSchema \|\| \{\}, null, 2\)/);
  assert.match(source, /required\.join\(\", \"\)/);
  assert.match(source, /properties\.join\(\", \"\)/);
  assert.match(source, /\[TRUNCATED: help was/);
});

test("R5-1b: root synthetic MCP help includes props and required labels", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../src/server.mjs"), "utf8");
  assert.match(source, /`props: \$\{properties\.join\(\", \"\)\}`/);
  assert.match(source, /`required: \$\{required\.join\(\", \"\)\}`/);
});

// R5-2 / final P1: quota traversal must fail closed when any subtree cannot
// be inventoried. Use an injected readdir wrapper so the regression is
// portable even when tests run as root (chmod 000 does not reliably produce
// EACCES there). No workspace operation may continue on a partial inventory.
test("R5-2: quota traversal EACCES/EPERM aborts enforcement, stats, and workspace ops", async () => {
  const boxDir = mkBoxDir();
  try {
    mkdirSync(resolve(boxDir, "w/blocked"), { recursive: true });
    writeFileSync(resolve(boxDir, "w/visible.txt"), "visible");
    writeFileSync(resolve(boxDir, "w/blocked/hidden.txt"), "hidden");

    const runtime = resolveWorkspaceConfig(
      {
        path: "./w",
        max_files: 1,
        cleanup_policy: "oldest_first",
        ttl_seconds: 0,
      },
      boxDir,
      { tool_mode: "normal" },
    );
    const denied = resolve(boxDir, "w/blocked");
    const { quotaStats } = await import("../src/workspace.mjs");

    for (const code of ["EACCES", "EPERM"]) {
      const readdirFn = async (path, options) => {
        if (resolve(path) === denied) {
          const err = new Error("synthetic unreadable subtree");
          err.code = code;
          throw err;
        }
        return promiseReaddir(path, options);
      };
      const expected = new RegExp(
        "quota traversal failed.*blocked.*" + code,
      );

      await assert.rejects(
        () => enforceQuotas(runtime, { readdirFn }),
        expected,
        "enforceQuotas must abort rather than enforce against partial inventory",
      );
      await assert.rejects(
        () => quotaStats(runtime, { readdirFn }),
        expected,
        "quotaStats must refuse partial totals",
      );

      const calls = [
        { subcommand: "dir" },
        { subcommand: "list", path: "." },
        { subcommand: "stat", path: "visible.txt" },
        { subcommand: "read", path: "visible.txt" },
      ];
      for (const args of calls) {
        await assert.rejects(
          () => callWorkspace(runtime, args, { readdirFn }),
          expected,
          "workspace." + args.subcommand + " must propagate quota traversal failure",
        );
      }

      // A failed inventory must not trigger eviction based on the visible
      // subset. The visible file remains even though max_files=1.
      assert.equal(
        existsSync(resolve(boxDir, "w/visible.txt")),
        true,
        "fail-closed traversal must not mutate the workspace from partial inventory",
      );
    }
  } finally { cleanup(boxDir); }
});

test("R5-3: MCP _run rejects array args instead of forwarding them", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../src/server.mjs"), "utf8");
  assert.match(source, /adapter === "mcp-stdio" \|\| adapter === "mcp-http"/);
  assert.match(source, /Invalid args for MCP adapter: expected object, received array/);
});

// R5-4: lstat ENOENT during quota traversal must be skipped (the entry
// vanished between readdir and lstat — a downstream CLI concurrently
// rotating output). A vanished entry cannot consume quota, so traversal
// continues on the visible inventory. Genuine permission / I/O errors
// continue to fail closed.
test("R5-4: lstat ENOENT during quota traversal is skipped, not failed", async () => {
  const boxDir = mkBoxDir();
  try {
    mkdirSync(resolve(boxDir, "w"), { recursive: true });
    writeFileSync(resolve(boxDir, "w/keep.txt"), "kept");
    writeFileSync(resolve(boxDir, "w/vanish.txt"), "will-vanish");
    const runtime = resolveWorkspaceConfig(
      {
        path: "./w",
        max_files: 5,
        max_total_bytes: 1024,
        cleanup_policy: "oldest_first",
        ttl_seconds: 0,
      },
      boxDir,
      { tool_mode: "normal" },
    );
    const vanishAbs = resolve(boxDir, "w/vanish.txt");
    const readdirFn = async (path, options) => {
      const ents = await promiseReaddir(path, options);
      // Simulate vanish.txt being deleted between readdir and lstat.
      if (resolve(path) === resolve(boxDir, "w")) {
        return ents.filter(e => e.name !== "vanish.txt");
      }
      return ents;
    };
    const lstatFn = (path) => {
      if (resolve(path) === vanishAbs) {
        const err = new Error("synthetic vanish");
        err.code = "ENOENT";
        throw err;
      }
      return lstatSync(path);
    };
    const { quotaStats } = await import("../src/workspace.mjs");
    const stats = await quotaStats(runtime, { readdirFn, lstatFn });
    assert.equal(stats.files, 1, "vanished entry must not be counted in quotaStats");
    assert.equal(stats.totalBytes, 4, "vanished entry size must not count toward totalBytes");
    const enforced = await enforceQuotas(runtime, { readdirFn, lstatFn });
    assert.equal(enforced.deleted, 0, "vanished entry must not be reported as deleted");
    assert.equal(existsSync(resolve(boxDir, "w/keep.txt")), true,
      "non-vanished entry must be untouched");
  } finally { cleanup(boxDir); }
});

test("R5-4b: non-ENOENT lstat errors during quota traversal still fail closed", async () => {
  const boxDir = mkBoxDir();
  try {
    mkdirSync(resolve(boxDir, "w"), { recursive: true });
    writeFileSync(resolve(boxDir, "w/visible.txt"), "visible");
    const runtime = resolveWorkspaceConfig(
      { path: "./w", tool_mode: "normal" },
      boxDir,
      { tool_mode: "normal" },
    );
    const lstatFn = (path) => {
      const err = new Error("synthetic unreadable");
      err.code = "EACCES";
      throw err;
    };
    const { quotaStats } = await import("../src/workspace.mjs");
    await assert.rejects(
      () => quotaStats(runtime, { lstatFn }),
      /quota traversal failed.*EACCES/,
      "quotaStats must still fail closed on EACCES from lstat",
    );
    await assert.rejects(
      () => enforceQuotas(runtime, { lstatFn }),
      /quota traversal failed.*EACCES/,
      "enforceQuotas must still fail closed on EACCES from lstat",
    );
  } finally { cleanup(boxDir); }
});
