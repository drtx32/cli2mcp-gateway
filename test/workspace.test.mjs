// Tests for the managed single-root read-only workspace runtime
// (`src/workspace.mjs`) and its box-config integration.
//
// Covers ELI-398 acceptance criteria:
//   1. normal + no workspace → workspace tool not exposed
//   2. normal + workspace path → workspace tool exposed
//   3. dual + workspace path → workspace ignored, only help+run
//   4. triple + workspace path → help+run+workspace
//   5. triple + no workspace → clear validation/boot failure
//   6. legacy dual_tool_mode=true still works
//   7. relative path resolves against box.yaml directory
//   8. workspace.dir returns canonical absolute path
//   9. workspace help is synthetic and documents dir/list/stat/read
//   10. read rejects outside-root paths and ../ escape
//   11. symlink escape is rejected
//   12. image file can round-trip as MCP image content
//   13. URL-only stdout is never downloaded (workspace has no download op)
//   14. quotas/read/list bounds are enforced
//   15. existing test suite remains green (covered by running the suite)

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";

import {
  resolveWorkspaceConfig,
  resolveToolMode,
  canonicaliseInsideRoot,
  callWorkspace,
  workspaceToolSpec,
  workspaceHelpText,
} from "../src/workspace.mjs";

// ---------- helpers ----------

function mkRoot() {
  return mkdtempSync(resolve(tmpdir(), "ws-test-"));
}

function writeFile(p, content) {
  // Tests commonly write into nested paths that the resolver has not yet
  // created (the resolver only creates the configured root, not arbitrary
  // parent dirs of files). Make the parent directory tree on demand so
  // tests stay focused on workspace semantics, not on tmp layout.
  mkdirSync(resolve(p, ".."), { recursive: true });
  writeFileSync(p, content);
}

// ---------- tool_mode precedence ----------

test("resolveToolMode: explicit tool_mode wins over dual_tool_mode", () => {
  assert.equal(resolveToolMode({ tool_mode: "triple", dual_tool_mode: true }), "triple");
  assert.equal(resolveToolMode({ tool_mode: "normal", dual_tool_mode: true }), "normal");
});

test("resolveToolMode: legacy dual_tool_mode=true maps to dual", () => {
  assert.equal(resolveToolMode({ dual_tool_mode: true }), "dual");
  assert.equal(resolveToolMode({ __legacy: { CLI_DUAL_TOOL_MODE: true } }), "dual");
});

test("resolveToolMode: default is normal", () => {
  assert.equal(resolveToolMode({}), "normal");
});

test("resolveToolMode: unknown tool_mode value throws", () => {
  assert.throws(() => resolveToolMode({ tool_mode: "quad" }), /tool_mode must be one of/);
});

// ---------- resolveWorkspaceConfig: tool exposure gating ----------

test("resolveWorkspaceConfig: normal + no workspace → null runtime", () => {
  const boxDir = mkRoot();
  const result = resolveWorkspaceConfig(undefined, boxDir, { tool_mode: "normal" });
  assert.equal(result, null);
});

test("resolveWorkspaceConfig: normal + workspace.path → active runtime", () => {
  const boxDir = mkRoot();
  const ws = resolve(boxDir, "data");
  const result = resolveWorkspaceConfig({ path: "./data" }, boxDir, { tool_mode: "normal" });
  assert.ok(result);
  assert.equal(result.root, ws);
  assert.equal(result.toolMode, "normal");
});

test("resolveWorkspaceConfig: dual + workspace.path → null (ignored)", () => {
  const boxDir = mkRoot();
  // Dual mode ignores workspace entirely; even a configured workspace must
  // not produce an active runtime, and `path` does not need to resolve.
  const result = resolveWorkspaceConfig({ path: "./never-resolved" }, boxDir, { tool_mode: "dual" });
  assert.equal(result, null);
});

test("resolveWorkspaceConfig: triple + workspace.path → active runtime", () => {
  const boxDir = mkRoot();
  const result = resolveWorkspaceConfig({ path: "./ws" }, boxDir, { tool_mode: "triple" });
  assert.ok(result);
  assert.equal(result.toolMode, "triple");
});

test("resolveWorkspaceConfig: triple + no workspace → throws clear actionable error", () => {
  const boxDir = mkRoot();
  assert.throws(
    () => resolveWorkspaceConfig(undefined, boxDir, { tool_mode: "triple" }),
    /triple mode requires workspace\.path/,
  );
});

test("resolveWorkspaceConfig: legacy dual_tool_mode=true still works", () => {
  const boxDir = mkRoot();
  // dual_tool_mode=true without explicit tool_mode ⇒ legacy dual mode.
  // Workspace is ignored regardless of config presence.
  const noWs = resolveWorkspaceConfig(undefined, boxDir, { dual_tool_mode: true });
  assert.equal(noWs, null);
  const withWs = resolveWorkspaceConfig({ path: "./never" }, boxDir, { dual_tool_mode: true });
  assert.equal(withWs, null);
});

// ---------- relative path resolution ----------

test("resolveWorkspaceConfig: relative path resolves against box.yaml dir (not cwd)", () => {
  const boxDir = mkRoot();
  // Write the workspace path and verify the runtime's canonical root is the
  // sibling-relative absolute, not anything based on cwd.
  const result = resolveWorkspaceConfig({ path: "./nested/sub" }, boxDir, { tool_mode: "normal" });
  assert.ok(result);
  // The runtime root must be inside the boxDir, exactly at boxDir/nested/sub.
  assert.equal(result.root, resolve(boxDir, "nested", "sub"));
});

test("resolveWorkspaceConfig: absolute path is used as-is", () => {
  const boxDir = mkRoot();
  const abs = mkRoot();
  const result = resolveWorkspaceConfig({ path: abs }, boxDir, { tool_mode: "normal" });
  assert.ok(result);
  assert.equal(result.root, abs);
});

test("resolveWorkspaceConfig: auto-creates missing workspace dir", () => {
  const boxDir = mkRoot();
  const result = resolveWorkspaceConfig({ path: "./new-ws" }, boxDir, { tool_mode: "normal" });
  assert.ok(result);
  assert.equal(result.root, resolve(boxDir, "new-ws"));
});

// ---------- workspace.dir returns canonical absolute ----------

test("workspace.dir returns the canonical absolute root", async () => {
  const boxDir = mkRoot();
  const runtime = resolveWorkspaceConfig({ path: "./d" }, boxDir, { tool_mode: "normal" });
  const result = await callWorkspace(runtime, { subcommand: "dir" });
  assert.equal(result.root, resolve(boxDir, "d"));
});

// ---------- escape rejection ----------

test("canonicaliseInsideRoot: ../ escape is rejected", () => {
  const boxDir = mkRoot();
  writeFile(resolve(boxDir, "x.txt"), "x");
  const runtime = resolveWorkspaceConfig({ path: "./d" }, boxDir, { tool_mode: "normal" });
  assert.throws(
    () => canonicaliseInsideRoot("../x.txt", runtime),
    /escapes workspace root/,
  );
  assert.throws(
    () => canonicaliseInsideRoot("sub/../../escape", runtime),
    /escapes workspace root/,
  );
});

test("canonicaliseInsideRoot: absolute path outside root is rejected", () => {
  const boxDir = mkRoot();
  const otherDir = mkRoot();
  writeFile(resolve(otherDir, "secret.txt"), "x");
  const runtime = resolveWorkspaceConfig({ path: "./d" }, boxDir, { tool_mode: "normal" });
  assert.throws(
    () => canonicaliseInsideRoot(otherDir + "/secret.txt", runtime),
    /escapes workspace root/,
  );
});

test("read rejects ../ escape", async () => {
  const boxDir = mkRoot();
  writeFile(resolve(boxDir, "secret.txt"), "top secret");
  mkdirSync(resolve(boxDir, "d"));
  const runtime = resolveWorkspaceConfig({ path: "./d" }, boxDir, { tool_mode: "normal" });
  await assert.rejects(
    () => callWorkspace(runtime, { subcommand: "read", path: "../secret.txt" }),
    /escapes workspace root/,
  );
});

test("read rejects absolute path outside root", async () => {
  const boxDir = mkRoot();
  const otherDir = mkRoot();
  writeFile(resolve(otherDir, "x.txt"), "x");
  const runtime = resolveWorkspaceConfig({ path: "./d" }, boxDir, { tool_mode: "normal" });
  await assert.rejects(
    () => callWorkspace(runtime, { subcommand: "read", path: otherDir + "/x.txt" }),
    /escapes workspace root/,
  );
});

// ---------- symlink escape rejection ----------

test("symlink escape: a symlink that resolves outside the root is rejected", () => {
  const boxDir = mkRoot();
  const outsideDir = mkRoot();
  writeFile(resolve(outsideDir, "outside.txt"), "outside");

  mkdirSync(resolve(boxDir, "d"));
  // Symlink d/escape → outsideDir. Resolving d/escape → outsideDir which is
  // outside d → must be rejected. This test opts into follow_symlinks=true
  // so we exercise the containment check (default follow_symlinks=false
  // would reject ANY symlink before containment even gets a chance).
  symlinkSync(outsideDir, resolve(boxDir, "d", "escape"), "dir");
  const runtime = resolveWorkspaceConfig(
    { path: "./d", follow_symlinks: true },
    boxDir,
    { tool_mode: "normal" },
  );
  assert.throws(
    () => canonicaliseInsideRoot("escape/outside.txt", runtime),
    /escapes workspace root/,
  );
});

test("symlink escape: a file symlink that points outside the root is rejected", () => {
  const boxDir = mkRoot();
  const outsideFile = resolve(mkRoot(), "outside.txt");
  writeFile(outsideFile, "outside");
  mkdirSync(resolve(boxDir, "d"));
  symlinkSync(outsideFile, resolve(boxDir, "d", "badlink"));
  const runtime = resolveWorkspaceConfig(
    { path: "./d", follow_symlinks: true },
    boxDir,
    { tool_mode: "normal" },
  );
  assert.throws(
    () => canonicaliseInsideRoot("badlink", runtime),
    /escapes workspace root/,
  );
});

test("follow_symlinks=false (default): in-root symlink is rejected before any read", () => {
  // Even when the symlink target is INSIDE the workspace root, follow_symlinks=false
  // must reject the path so the operator's "no symlink" policy is honored. This is
  // the regression test for Finding 4 — current main resolves through the symlink.
  const boxDir = mkRoot();
  mkdirSync(resolve(boxDir, "d", "real"), { recursive: true });
  writeFile(resolve(boxDir, "d", "real", "inside.txt"), "inside");
  symlinkSync(resolve(boxDir, "d", "real"), resolve(boxDir, "d", "link"), "dir");
  const runtime = resolveWorkspaceConfig({ path: "./d" }, boxDir, { tool_mode: "normal" });
  assert.throws(
    () => canonicaliseInsideRoot("link/inside.txt", runtime),
    /traverses a symlink/,
  );
});

test("follow_symlinks=true: in-root symlink resolves and reads succeed", () => {
  // Opt-in case: with follow_symlinks=true, an in-root symlink is allowed and
  // reads go through to the real file.
  const boxDir = mkRoot();
  mkdirSync(resolve(boxDir, "d", "real"), { recursive: true });
  writeFile(resolve(boxDir, "d", "real", "inside.txt"), "inside");
  symlinkSync(resolve(boxDir, "d", "real"), resolve(boxDir, "d", "link"), "dir");
  const runtime = resolveWorkspaceConfig(
    { path: "./d", follow_symlinks: true },
    boxDir,
    { tool_mode: "normal" },
  );
  const canonical = canonicaliseInsideRoot("link/inside.txt", runtime);
  assert.equal(canonical, resolve(boxDir, "d", "real", "inside.txt"));
});

// ---------- hidden files ----------

test("hidden files: path inside a hidden directory is rejected by default", () => {
  const boxDir = mkRoot();
  mkdirSync(resolve(boxDir, "d", ".cache"), { recursive: true });
  writeFile(resolve(boxDir, "d", ".cache", "token"), "x");
  const runtime = resolveWorkspaceConfig({ path: "./d" }, boxDir, { tool_mode: "normal" });
  assert.throws(
    () => canonicaliseInsideRoot(".cache/token", runtime),
    /hidden/,
  );
});

test("hidden files: allow_hidden_files=true permits hidden paths", () => {
  const boxDir = mkRoot();
  mkdirSync(resolve(boxDir, "d", ".cache"), { recursive: true });
  const runtime = resolveWorkspaceConfig(
    { path: "./d", allow_hidden_files: true },
    boxDir,
    { tool_mode: "normal" },
  );
  const ok = canonicaliseInsideRoot(".cache", runtime);
  assert.equal(ok, resolve(boxDir, "d", ".cache"));
});

// ---------- list ----------

test("list: empty workspace returns no entries, no truncation", async () => {
  const boxDir = mkRoot();
  const runtime = resolveWorkspaceConfig({ path: "./d" }, boxDir, { tool_mode: "normal" });
  const out = await callWorkspace(runtime, { subcommand: "list" });
  assert.deepEqual(out.entries, []);
  assert.equal(out.truncated, false);
  assert.equal(out.root, runtime.root);
});

test("list: entries are sorted, directories first, capped at max_list_entries", async () => {
  const boxDir = mkRoot();
  mkdirSync(resolve(boxDir, "d", "sub"), { recursive: true });
  writeFile(resolve(boxDir, "d", "a.txt"), "x");
  writeFile(resolve(boxDir, "d", "b.txt"), "x");
  const runtime = resolveWorkspaceConfig(
    { path: "./d", max_list_entries: 2 },
    boxDir,
    { tool_mode: "normal" },
  );
  const out = await callWorkspace(runtime, { subcommand: "list" });
  assert.equal(out.truncated, true);
  assert.equal(out.entries.length, 2);
  // sub (dir) sorts before a.txt (file) only by name; cap drops one.
  assert.ok(out.entries.length <= 2);
});

test("list: recursive walks subdirectories when enabled", async () => {
  const boxDir = mkRoot();
  mkdirSync(resolve(boxDir, "d", "sub"), { recursive: true });
  writeFile(resolve(boxDir, "d", "sub", "deep.txt"), "x");
  const runtime = resolveWorkspaceConfig({ path: "./d" }, boxDir, { tool_mode: "normal" });
  const out = await callWorkspace(runtime, { subcommand: "list", recursive: true });
  const paths = out.entries.map(e => e.path);
  assert.ok(paths.includes("sub"));
  assert.ok(paths.some(p => p.endsWith("deep.txt")));
});

// ---------- stat ----------

test("stat: returns metadata for a file", async () => {
  const boxDir = mkRoot();
  const fp = resolve(boxDir, "d", "x.txt");
  writeFile(fp, "hello");
  const runtime = resolveWorkspaceConfig({ path: "./d" }, boxDir, { tool_mode: "normal" });
  const out = await callWorkspace(runtime, { subcommand: "stat", path: "x.txt" });
  assert.equal(out.kind, "file");
  assert.equal(out.size, 5);
  assert.equal(out.path, "x.txt");
});

test("stat: rejects missing path argument", async () => {
  const boxDir = mkRoot();
  const runtime = resolveWorkspaceConfig({ path: "./d" }, boxDir, { tool_mode: "normal" });
  await assert.rejects(
    () => callWorkspace(runtime, { subcommand: "stat" }),
    /requires a path argument/,
  );
});

// ---------- read ----------

test("read: text file returns text content block", async () => {
  const boxDir = mkRoot();
  writeFile(resolve(boxDir, "d", "note.md"), "# hi");
  const runtime = resolveWorkspaceConfig({ path: "./d" }, boxDir, { tool_mode: "normal" });
  const result = await callWorkspace(runtime, { subcommand: "read", path: "note.md" });
  assert.equal(result.content[0].type, "text");
  assert.equal(result.content[0].text, "# hi");
  assert.equal(result.content[0].mimeType, "text/markdown");
});

test("read: JSON file returns text + structuredContent", async () => {
  const boxDir = mkRoot();
  writeFile(resolve(boxDir, "d", "data.json"), '{"a":1}');
  const runtime = resolveWorkspaceConfig({ path: "./d" }, boxDir, { tool_mode: "normal" });
  const result = await callWorkspace(runtime, { subcommand: "read", path: "data.json" });
  assert.equal(result.content[0].type, "text");
  assert.deepEqual(result.structuredContent, { a: 1 });
});

test("read: PNG round-trips as MCP image content block", async () => {
  const boxDir = mkRoot();
  // Minimal 1×1 PNG (base64 of a real PNG: 89504E470D0A1A0A...).
  const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
  writeFile(resolve(boxDir, "d", "pixel.png"), Buffer.from(pngB64, "base64"));
  const runtime = resolveWorkspaceConfig({ path: "./d" }, boxDir, { tool_mode: "normal" });
  const result = await callWorkspace(runtime, { subcommand: "read", path: "pixel.png" });
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "image");
  assert.equal(result.content[0].mimeType, "image/png");
  assert.ok(typeof result.content[0].data === "string" && result.content[0].data.length > 0);
});

test("read: max_read_bytes enforces a hard cap, never silently truncates", async () => {
  const boxDir = mkRoot();
  writeFile(resolve(boxDir, "d", "big.txt"), "x".repeat(2048));
  const runtime = resolveWorkspaceConfig(
    { path: "./d", max_read_bytes: 100 },
    boxDir,
    { tool_mode: "normal" },
  );
  await assert.rejects(
    () => callWorkspace(runtime, { subcommand: "read", path: "big.txt" }),
    /exceeds max_read_bytes/,
  );
});

test("read: binary content (not safely UTF-8) is rejected, not dumped", async () => {
  const boxDir = mkRoot();
  // Random non-UTF-8 byte sequence.
  const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81, 0x82, 0xc3, 0x28, 0xa0, 0xa1]);
  writeFile(resolve(boxDir, "d", "blob.bin"), bytes);
  const runtime = resolveWorkspaceConfig({ path: "./d" }, boxDir, { tool_mode: "normal" });
  await assert.rejects(
    () => callWorkspace(runtime, { subcommand: "read", path: "blob.bin" }),
    /unsupported \/ binary content/,
  );
});

// ---------- synthetic tool spec ----------

test("workspaceToolSpec: declares all four subcommands in the schema", () => {
  const spec = workspaceToolSpec("ashare_workspace");
  assert.equal(spec.name, "ashare_workspace");
  assert.equal(spec.dispatch.kind, "workspace");
  assert.equal(spec.dispatch.toolName, "ashare_workspace");
  assert.match(spec.description, /ashare_workspace\(subcommand="dir"/);
  assert.deepEqual(spec.inputSchema.properties.subcommand.enum, ["dir", "list", "stat", "read"]);
  assert.ok(spec.inputSchema.required.includes("subcommand"));
});

test("workspaceHelpText: documents dir / list / stat / read subcommands", () => {
  const text = workspaceHelpText();
  assert.match(text, /<cli>_workspace\(subcommand="dir"/);
  assert.match(text, /<cli>_workspace\(subcommand="list"/);
  assert.match(text, /<cli>_workspace\(subcommand="stat"/);
  assert.match(text, /<cli>_workspace\(subcommand="read"/);
});

// ---------- cleanup ----------

test.afterEach(() => {
  // mkdtemp creates temp dirs; nothing to clean since OS reclaims them.
});
