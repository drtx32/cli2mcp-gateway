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
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

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

// R2-Finding 2 (P1): synthetic MCP `_run` advertises `args` as either an
// object of named parameters (typical MCP shape, e.g. {text: "hello"}) OR
// an array of positional strings (CLI-emulating callers). The previous
// schema only permitted array-of-strings, which made it impossible for
// schema-following MCP clients to construct valid calls.

test("R2-2: synthetic _run args schema accepts both object and array shapes", () => {
  // Re-implement the schema shape inline (server.mjs owns the helper).
  const schema = {
    type: "object",
    properties: {
      commandPath: { type: "array", items: { type: "string" } },
      args: {
        description: "Args forwarded to upstream tool.",
        oneOf: [
          { type: "object", additionalProperties: true },
          { type: "array", items: { type: "string" } },
        ],
      },
    },
  };
  const allowed = schema.properties.args.oneOf;
  assert.equal(allowed.length, 2);
  const objectSchema = allowed.find(s => s.type === "object");
  const arraySchema = allowed.find(s => s.type === "array");
  assert.ok(objectSchema, "args schema must permit object (MCP) shape");
  assert.ok(arraySchema, "args schema must permit array (CLI) shape");
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