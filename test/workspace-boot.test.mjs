// End-to-end boot test: load box.yaml via server.mjs's loadBoxConfig path,
// then build the tool catalog through the same aggregator used at boot,
// and verify the synthetic "workspace" tool surfaces only in the right modes.
//
// We don't actually start the HTTP/stdio server (that would block); we
// re-use the public loadBoxConfig + resolveWorkspaceConfig + workspaceToolSpec
// pipeline, which is exactly what server.mjs does at boot before the
// transport comes up.

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { loadBoxConfig } from "../src/box-config.mjs";
import { aggregateTools } from "../src/tool-aggregator.mjs";
import {
  resolveWorkspaceConfig,
  workspaceToolSpec,
  appendWorkspaceTool,
} from "../src/workspace.mjs";

function mkBoxDir() {
  return mkdtempSync(resolve(tmpdir(), "box-boot-"));
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

test("boot pipeline: normal + workspace path → workspace tool appears", () => {
  const dir = mkBoxDir();
  try {
    const p = resolve(dir, "box.yaml");
    writeFileSync(p, `
name: n
services:
  s:
    adapter: cli
    command: ashare
    workspace: { path: ./ws }
transport: {type: stdio}
auth: {mode: none}
`);
    const { config } = loadBoxConfig(p);
    // Simulate discovered help/command tools without starting a CLI subprocess.
    const perServiceTools = { s: [
      { name: "ashare_help", dispatch: { kind: "help" } },
      { name: "ashare_reports", dispatch: { kind: "cli" } },
    ] };
    const rt = resolveWorkspaceConfig(
      config.services.s.workspace,
      resolve(p, ".."),
      config.services.s,
    );
    if (rt) appendWorkspaceTool(perServiceTools.s, workspaceToolSpec("ashare_workspace"));
    const agg = aggregateTools(perServiceTools, { auto_unwrap_single_service: true });
    const names = agg.map(t => t.name).sort();
    assert.ok(names.includes("ashare_workspace"));
    assert.ok(names.includes("ashare_help"));
    assert.ok(names.includes("ashare_reports"));
    assert.equal(names.includes("workspace"), false);
  } finally { cleanup(dir); }
});

test("boot pipeline: normal + no workspace → workspace tool not exposed", () => {
  const dir = mkBoxDir();
  try {
    const p = resolve(dir, "box.yaml");
    writeFileSync(p, `
name: n
services:
  s:
    adapter: cli
    command: ashare
transport: {type: stdio}
auth: {mode: none}
`);
    const { config } = loadBoxConfig(p);
    const perServiceTools = { s: [] };
    const rt = resolveWorkspaceConfig(
      config.services.s.workspace,
      resolve(p, ".."),
      config.services.s,
    );
    if (rt) appendWorkspaceTool(perServiceTools.s, workspaceToolSpec("ashare_workspace"));
    const agg = aggregateTools(perServiceTools, { separator: "__" });
    const names = agg.map(t => t.name);
    assert.equal(names.includes("s__ashare_workspace"), false);
  } finally { cleanup(dir); }
});

test("boot pipeline: dual + workspace path → workspace ignored, no tool", () => {
  const dir = mkBoxDir();
  try {
    const p = resolve(dir, "box.yaml");
    writeFileSync(p, `
name: n
services:
  s:
    adapter: cli
    command: ashare
    tool_mode: dual
    workspace: { path: ./never }
transport: {type: stdio}
auth: {mode: none}
`);
    const { config } = loadBoxConfig(p);
    const perServiceTools = { s: [] };
    const rt = resolveWorkspaceConfig(
      config.services.s.workspace,
      resolve(p, ".."),
      config.services.s,
    );
    if (rt) appendWorkspaceTool(perServiceTools.s, workspaceToolSpec("ashare_workspace"));
    const agg = aggregateTools(perServiceTools, { separator: "__" });
    const names = agg.map(t => t.name);
    assert.equal(names.includes("s__ashare_workspace"), false);
  } finally { cleanup(dir); }
});

test("boot pipeline: triple + no workspace → resolver throws (boot fails)", () => {
  const dir = mkBoxDir();
  try {
    const p = resolve(dir, "box.yaml");
    writeFileSync(p, `
name: n
services:
  s:
    adapter: cli
    command: ashare
    tool_mode: triple
transport: {type: stdio}
auth: {mode: none}
`);
    const { config } = loadBoxConfig(p);
    assert.throws(
      () => resolveWorkspaceConfig(
        config.services.s.workspace,
        resolve(p, ".."),
        config.services.s,
      ),
      /triple mode requires workspace\.path/,
    );
  } finally { cleanup(dir); }
});

test("boot pipeline: legacy dual_tool_mode=true still parses", () => {
  const dir = mkBoxDir();
  try {
    const p = resolve(dir, "box.yaml");
    writeFileSync(p, `
name: n
services:
  s:
    adapter: cli
    command: ashare
    dual_tool_mode: true
    workspace: { path: ./ignored }
transport: {type: stdio}
auth: {mode: none}
`);
    const { config } = loadBoxConfig(p);
    const perServiceTools = { s: [] };
    const rt = resolveWorkspaceConfig(
      config.services.s.workspace,
      resolve(p, ".."),
      config.services.s,
    );
    if (rt) appendWorkspaceTool(perServiceTools.s, workspaceToolSpec("ashare_workspace"));
    const agg = aggregateTools(perServiceTools, { separator: "__" });
    const names = agg.map(t => t.name);
    assert.equal(names.includes("s__ashare_workspace"), false);
  } finally { cleanup(dir); }
});

test("boot pipeline: triple mode exposes exactly namespaced help, run, and workspace", () => {
  const tools = [
    { name: "ashare_help", dispatch: { kind: "help" } },
    { name: "ashare_run", dispatch: { kind: "run" } },
  ];
  appendWorkspaceTool(tools, workspaceToolSpec("ashare_workspace"));
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "ashare_help", "ashare_run", "ashare_workspace",
  ]);
});

test("normal mode: exact CLI tool name collision fails with both origins", () => {
  const tools = [{ name: "ashare_workspace", dispatch: { kind: "cli", commandPath: ["workspace"] } }];
  assert.throws(
    () => appendWorkspaceTool(tools, workspaceToolSpec("ashare_workspace"), {
      toolMode: "normal",
      adapter: "cli",
    }),
    /collision on "ashare_workspace": real CLI-discovered command conflicts with gateway synthetic workspace tool/,
  );
  assert.equal(tools.length, 1);
});

for (const adapter of ["mcp-stdio", "mcp-http"]) {
  test(`normal ${adapter} mode: upstream workspace collision fails instead of shadowing`, () => {
    const toolName = "ashare_workspace";
    const upstreamTools = [{ name: toolName, dispatch: { kind: "upstream" } }];
    assert.throws(
      () => appendWorkspaceTool(upstreamTools, workspaceToolSpec(toolName), {
        toolMode: "normal",
        adapter,
      }),
      new RegExp(`collision on "${toolName}": upstream-discovered MCP tool conflicts with gateway synthetic workspace tool`),
    );
    assert.equal(upstreamTools.length, 1);
    assert.equal(upstreamTools[0].dispatch.kind, "upstream");
  });
}

test("workspace help: workspaceHelpText mentions every subcommand and the security model", async () => {
  const { workspaceHelpText } = await import("../src/workspace.mjs");
  const text = workspaceHelpText();
  for (const sub of ["dir", "list", "stat", "read"]) {
    assert.ok(text.includes(sub), `help should mention subcommand "${sub}"`);
  }
  assert.match(text, /symlink/);
  assert.match(text, /max_read_bytes/);
  assert.match(text, /hidden/);
});
