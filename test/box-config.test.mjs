import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { legacyEnvConfig, loadBoxConfig } from "../src/box-config.mjs";
import { aggregateTools, buildDispatchTable, resolveToolCall } from "../src/tool-aggregator.mjs";

// ---------- legacyEnvConfig ----------

test("legacyEnvConfig: defaults to CLI_COMMAND env or 'rg'", () => {
  const orig = { ...process.env };
  try {
    // Strip any CLI_COMMAND / CLI2MCP_COMMAND that might leak from the
    // test runner, so we exercise the literal "rg" fallback.
    delete process.env.CLI_COMMAND;
    delete process.env.CLI2MCP_COMMAND;
    process.env.PORT = "3200";
    process.env.AUTH_MODE = "bearer";
    process.env.MCP_TOKEN = "tok-legacy";
    const box = legacyEnvConfig();
    assert.equal(box.name, "legacy-rg");
    assert.equal(box.services.rg.adapter, "cli");
    assert.equal(box.services.rg.command, "rg");
    assert.equal(box.transport.type, "http");
    assert.equal(box.transport.port, 3200);
    assert.equal(box.auth.token, "tok-legacy");
  } finally {
    process.env = orig;
  }
});

test("legacyEnvConfig: respects CLI_DUAL_TOOL_MODE on the cli service", () => {
  const orig = { ...process.env };
  try {
    process.env.CLI_COMMAND = "multica";
    process.env.CLI_DUAL_TOOL_MODE = "true";
    const box = legacyEnvConfig();
    assert.equal(box.services.multica.__legacy.CLI_DUAL_TOOL_MODE, true);
  } finally {
    process.env = orig;
  }
});

// ---------- loadBoxConfig ----------

test("loadBoxConfig: parses a minimal box.yaml with one cli service", () => {
  const yaml = `
name: demo
services:
  ashare:
    adapter: cli
    command: ashare
transport:
  type: http
  host: 127.0.0.1
  port: 3100
auth:
  mode: bearer
  token: "abc"
`;
  const { config } = loadBoxConfigFromString(yaml);
  assert.equal(config.name, "demo");
  assert.equal(config.services.ashare.command, "ashare");
  assert.equal(config.transport.port, 3100);
  assert.equal(config.auth.token, "abc");
});

test("loadBoxConfig: accepts auto and mcp-http service adapters", () => {
  const dir = fs.mkdtempSync(path.resolve(os.tmpdir(), "cli2mcp-adapters-"));
  const boxPath = path.resolve(dir, "box.yaml");
  try {
    fs.writeFileSync(boxPath, [
      "name: adapters",
      "services:",
      "  detected:",
      "    adapter: auto",
      "    command: node",
      "  remote:",
      "    adapter: mcp-http",
      "    url: https://example.com/mcp",
      "    auth: {type: bearer, token: token}",
      "transport: {type: stdio}",
      "",
    ].join("\n"), "utf8");
    const { config } = loadBoxConfig(boxPath);
    assert.equal(config.services.detected.adapter, "auto");
    assert.equal(config.services.remote.adapter, "mcp-http");
    assert.equal(config.services.remote.auth.token, "token");
  } finally {
    if (fs.existsSync(boxPath)) fs.unlinkSync(boxPath);
    if (fs.existsSync(dir)) fs.rmdirSync(dir);
  }
});

test("loadBoxConfig: rejects unknown adapter kind at the schema layer", () => {
  const yaml = `
name: bad
services:
  what:
    adapter: not-a-real-adapter
    command: x
transport:
  type: http
  port: 3100
auth: {mode: bearer}
`;
  assert.throws(
      () => loadBoxConfigFromString(yaml),
      /failed validation/,
    );
});

test("loadBoxConfig: expands \\${VAR} in service.command", () => {
  const orig = { ...process.env };
  try {
    process.env.MY_CLI = "alpha";
    const yaml = `
name: e
services:
  s:
    adapter: cli
    command: "\${MY_CLI}"
transport: {type: http, port: 3100}
auth: {mode: bearer}
`;
    const { config } = loadBoxConfigFromString(yaml);
    assert.equal(config.services.s.command, "alpha");
  } finally {
    process.env = orig;
  }
});

test("loadBoxConfig: missing required env_file with required: true throws", () => {
  const yaml = `
name: e
services:
  s:
    adapter: cli
    command: x
    env_file:
      - path: /nonexistent/secret.env
        required: true
transport: {type: http, port: 3100}
auth: {mode: bearer}
`;
  assert.throws(
    () => loadBoxConfigFromString(yaml),
    /required env_file not found/,
  );
});

test("loadBoxConfig: missing optional env_file is silently skipped", () => {
  const yaml = `
name: e
services:
  s:
    adapter: cli
    command: x
    env_file:
      - /nonexistent/optional.env
transport: {type: http, port: 3100}
auth: {mode: bearer}
`;
  const { config } = loadBoxConfigFromString(yaml);
  assert.deepEqual(config.services.s.env, {});
});

// ---------- aggregateTools ----------

test("aggregateTools: prefixes every tool with upstreamName", () => {
  const out = aggregateTools({
    ashare: [{ name: "list", description: "d", inputSchema: {} }],
    multica: [{ name: "run", description: "d", inputSchema: {} }],
  });
  const names = out.map(t => t.name).sort();
  assert.deepEqual(names, ["ashare__list", "multica__run"]);
});

test("aggregateTools: keeps originalName for dispatch lookup", () => {
  const out = aggregateTools({
    ashare: [{ name: "list", description: "d", inputSchema: {} }],
  });
  assert.equal(out[0].originalName, "list");
  assert.equal(out[0].serviceName, "ashare");
});

test("aggregateTools: collision_policy=error: distinct namespaces never throw", () => {
  // With `prefix_upstream` (default) and any separator, each (serviceName,
  // originalName) pair produces a unique qualified name by construction, so
  // collision_policy=error never fires. This test pins that invariant.
  const out = aggregateTools(
    {
      a: [{ name: "x", description: "d", inputSchema: {} }],
      b: [{ name: "y", description: "d", inputSchema: {} }],
    },
    { separator: "__", collision_policy: "error" },
  );
  assert.equal(out.length, 2);
});

test("aggregateTools: collision_policy=prefix_upstream is collision-tolerant", () => {
  const out = aggregateTools(
    {
      a: [{ name: "x", description: "d", inputSchema: {} }],
      b: [{ name: "x", description: "d", inputSchema: {} }],
    },
    { separator: "__", collision_policy: "prefix_upstream" },
  );
  // Two distinct qualified names — one per service.
  assert.equal(out.length, 2);
  assert.equal(new Set(out.map(t => t.name)).size, 2);
});

test("aggregateTools: sorts output stably by (service, originalName)", () => {
  const out = aggregateTools({
    zeta: [{ name: "run", description: "d", inputSchema: {} }],
    alpha: [{ name: "list", description: "d", inputSchema: {} }],
  });
  assert.deepEqual(out.map(t => t.serviceName), ["alpha", "zeta"]);
});

// ---------- buildDispatchTable / resolveToolCall ----------

test("resolveToolCall: returns owning service for qualified tool", () => {
  const agg = aggregateTools({
    ashare: [{ name: "list", description: "d", inputSchema: {} }],
    multica: [{ name: "run", description: "d", inputSchema: {} }],
  });
  const dispatch = buildDispatchTable(agg);
  assert.deepEqual(resolveToolCall(dispatch, "multica__run"), {
    serviceName: "multica",
    originalName: "run",
  });
  assert.deepEqual(resolveToolCall(dispatch, "ashare__list"), {
    serviceName: "ashare",
    originalName: "list",
  });
  assert.equal(resolveToolCall(dispatch, "missing__tool"), null);
});

// ---------- helper ----------

function loadBoxConfigFromString(yamlText) {
  // Avoid touching real disk: re-use the loader by writing into a temp file.
  // We use a per-test tmp path so parallel runs are isolated.
  const tmp = path.join(os.tmpdir(), `box-${Math.random().toString(36).slice(2)}.yaml`);
  fs.writeFileSync(tmp, yamlText, "utf8");
  try {
    return loadBoxConfig(tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}
