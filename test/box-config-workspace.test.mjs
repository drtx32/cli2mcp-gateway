// Tests for the box-config integration of managed workspace + triple mode.
// These cover the schema layer and the resolution that server.mjs uses at
// boot: tool_mode precedence, triple-mode enforcement, dual-mode ignoring,
// relative-path resolution against the box.yaml directory.

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";

import { loadBoxConfig } from "../src/box-config.mjs";
import {
  resolveWorkspaceConfig,
  resolveToolMode,
} from "../src/workspace.mjs";

// ---------- helpers ----------

function writeYaml(dir, name, content) {
  const p = resolve(dir, name);
  writeFileSync(p, content);
  return p;
}

function mkBoxDir() {
  return mkdtempSync(resolve(tmpdir(), "box-ws-"));
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ---------- tool_mode + workspace integration ----------

test("box.yaml: normal mode without workspace → no workspace runtime", () => {
  const dir = mkBoxDir();
  try {
    const p = writeYaml(dir, "box.yaml", `
name: x
services:
  s:
    adapter: cli
    command: ashare
transport: {type: stdio}
auth: {mode: none}
`);
    const { config } = loadBoxConfig(p);
    const rt = resolveWorkspaceConfig(
      config.services.s.workspace,
      dirname(p),
      config.services.s,
    );
    assert.equal(rt, null);
  } finally { cleanup(dir); }
});

test("box.yaml: normal mode with workspace.path → workspace tool exposed", () => {
  const dir = mkBoxDir();
  try {
    const p = writeYaml(dir, "box.yaml", `
name: x
services:
  s:
    adapter: cli
    command: ashare
    workspace:
      path: ./data
transport: {type: stdio}
auth: {mode: none}
`);
    const { config } = loadBoxConfig(p);
    const rt = resolveWorkspaceConfig(
      config.services.s.workspace,
      dirname(p),
      config.services.s,
    );
    assert.ok(rt);
    assert.equal(rt.root, resolve(p + "/../data"));
  } finally { cleanup(dir); }
});

test("box.yaml: dual mode + workspace.path → workspace is ignored", () => {
  const dir = mkBoxDir();
  try {
    const p = writeYaml(dir, "box.yaml", `
name: x
services:
  s:
    adapter: cli
    command: ashare
    tool_mode: dual
    workspace:
      path: ./never-created
transport: {type: stdio}
auth: {mode: none}
`);
    const { config } = loadBoxConfig(p);
    const rt = resolveWorkspaceConfig(
      config.services.s.workspace,
      dirname(p),
      config.services.s,
    );
    assert.equal(rt, null);
  } finally { cleanup(dir); }
});

test("box.yaml: triple mode + workspace.path → workspace runtime active", () => {
  const dir = mkBoxDir();
  try {
    const p = writeYaml(dir, "box.yaml", `
name: x
services:
  s:
    adapter: cli
    command: ashare
    tool_mode: triple
    workspace:
      path: ./w
transport: {type: stdio}
auth: {mode: none}
`);
    const { config } = loadBoxConfig(p);
    const rt = resolveWorkspaceConfig(
      config.services.s.workspace,
      dirname(p),
      config.services.s,
    );
    assert.ok(rt);
    assert.equal(rt.toolMode, "triple");
  } finally { cleanup(dir); }
});

test("box.yaml: triple mode without workspace → schema-validated but resolver throws", () => {
  const dir = mkBoxDir();
  try {
    const p = writeYaml(dir, "box.yaml", `
name: x
services:
  s:
    adapter: cli
    command: ashare
    tool_mode: triple
transport: {type: stdio}
auth: {mode: none}
`);
    const { config } = loadBoxConfig(p);
    // The YAML passes schema validation — the failure is at boot when the
    // server tries to resolve the workspace runtime.
    assert.equal(config.services.s.tool_mode, "triple");
    assert.throws(
      () => resolveWorkspaceConfig(
        config.services.s.workspace,
        dirname(p),
        config.services.s,
      ),
      /triple mode requires workspace\.path/,
    );
  } finally { cleanup(dir); }
});

test("box.yaml: legacy dual_tool_mode=true still parses and the workspace is ignored", () => {
  const dir = mkBoxDir();
  try {
    const p = writeYaml(dir, "box.yaml", `
name: x
services:
  s:
    adapter: cli
    command: ashare
    dual_tool_mode: true
    workspace:
      path: ./ignored
transport: {type: stdio}
auth: {mode: none}
`);
    const { config } = loadBoxConfig(p);
    // Workspace present in YAML but tool_mode resolves to dual → ignored.
    const rt = resolveWorkspaceConfig(
      config.services.s.workspace,
      dirname(p),
      config.services.s,
    );
    assert.equal(rt, null);
    // legacy dual_tool_mode still wins when explicit tool_mode is absent.
    assert.equal(resolveToolMode(config.services.s), "dual");
  } finally { cleanup(dir); }
});

test("box.yaml: explicit tool_mode=triple wins over legacy dual_tool_mode=true", () => {
  const dir = mkBoxDir();
  try {
    const p = writeYaml(dir, "box.yaml", `
name: x
services:
  s:
    adapter: cli
    command: ashare
    tool_mode: triple
    dual_tool_mode: true
    workspace:
      path: ./w
transport: {type: stdio}
auth: {mode: none}
`);
    const { config } = loadBoxConfig(p);
    assert.equal(resolveToolMode(config.services.s), "triple");
    const rt = resolveWorkspaceConfig(
      config.services.s.workspace,
      dirname(p),
      config.services.s,
    );
    assert.ok(rt);
    assert.equal(rt.toolMode, "triple");
  } finally { cleanup(dir); }
});

test("box.yaml: invalid tool_mode value fails schema validation", () => {
  const dir = mkBoxDir();
  try {
    const p = writeYaml(dir, "box.yaml", `
name: x
services:
  s:
    adapter: cli
    command: ashare
    tool_mode: quad
transport: {type: stdio}
auth: {mode: none}
`);
    assert.throws(
      () => loadBoxConfig(p),
      /failed validation/,
    );
  } finally { cleanup(dir); }
});

test("box.yaml: workspace defaults populate max_read_bytes / max_list_entries", () => {
  const dir = mkBoxDir();
  try {
    const p = writeYaml(dir, "box.yaml", `
name: x
services:
  s:
    adapter: cli
    command: ashare
    workspace:
      path: ./w
      max_read_bytes: 1024
      max_list_entries: 7
transport: {type: stdio}
auth: {mode: none}
`);
    const { config } = loadBoxConfig(p);
    const rt = resolveWorkspaceConfig(
      config.services.s.workspace,
      dirname(p),
      config.services.s,
    );
    assert.ok(rt);
    assert.equal(rt.maxReadBytes, 1024);
    assert.equal(rt.maxListEntries, 7);
  } finally { cleanup(dir); }
});

test("box.yaml: workspace follow_symlinks defaults to false, allow_hidden_files to false", () => {
  const dir = mkBoxDir();
  try {
    const p = writeYaml(dir, "box.yaml", `
name: x
services:
  s:
    adapter: cli
    command: ashare
    workspace:
      path: ./w
transport: {type: stdio}
auth: {mode: none}
`);
    const { config } = loadBoxConfig(p);
    const rt = resolveWorkspaceConfig(
      config.services.s.workspace,
      dirname(p),
      config.services.s,
    );
    assert.equal(rt.followSymlinks, false);
    assert.equal(rt.allowHidden, false);
  } finally { cleanup(dir); }
});