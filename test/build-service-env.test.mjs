import test from "node:test";
import assert from "node:assert/strict";

import { TASK_SCOPED_KEYS, buildServiceEnv } from "../src/service-env.mjs";

// Regression: forwarding parent process env (which carries hermes task
// identity from a PM2 daemon parent) to a downstream CLI caused
// "Task token rejected" failures when that CLI was `multica`. Stripping
// these keys forces the CLI to fall back to its daemon socket + user PAT.

test("TASK_SCOPED_KEYS: lists all hermes task-identity + daemon-injection env vars", () => {
  // Three groups: (a) task identity, (b) daemon-injected transport,
  // (c) misc hermes runtime knobs.
  assert.equal(TASK_SCOPED_KEYS.length, 30);
  for (const k of [
    // task identity
    "MULTICA_TOKEN",
    "MULTICA_TASK_ID",
    "MULTICA_TASK_SLOT",
    "MULTICA_AGENT_ID",
    "MULTICA_AGENT_NAME",
    "MULTICA_WORKSPACE_ID",
    "MULTICA_TASK_CONFIG_ROOT",
    "MULTICA_TASK_WORKSPACES_ROOT",
    "MULTICA_DAEMON_ID",
    // daemon transport
    "MULTICA_DAEMON_PORT",
    "MULTICA_SERVER_URL",
  ]) {
    assert.ok(TASK_SCOPED_KEYS.includes(k), `missing ${k}`);
  }
  assert.ok(Object.isFrozen(TASK_SCOPED_KEYS));
});

test("buildServiceEnv: strips all TASK_SCOPED_KEYS from parent env", () => {
  const parent = {
    MULTICA_TOKEN: "mat_xxx",
    MULTICA_TASK_ID: "01a04397-acac",
    MULTICA_AGENT_ID: "511eb3bb-8439",
    MULTICA_DAEMON_PORT: "19514",
    MULTICA_SERVER_URL: "https://api.multica.ai",
    HOME: "/root",
    PATH: "/usr/bin:/bin",
  };
  const result = buildServiceEnv(parent);
  for (const k of TASK_SCOPED_KEYS) {
    assert.equal(result[k], undefined, `${k} should be stripped`);
  }
  assert.equal(result.HOME, "/root");
  assert.equal(result.PATH, "/usr/bin:/bin");
});

test("buildServiceEnv: does not mutate the parent env object", () => {
  const parent = { MULTICA_TOKEN: "mat_xxx", HOME: "/root" };
  const before = JSON.stringify(parent);
  buildServiceEnv(parent);
  assert.equal(JSON.stringify(parent), before);
});

test("buildServiceEnv: svcEnv overrides take precedence over parent", () => {
  const parent = { HOME: "/root", MCP_TOKEN: "parent-tok" };
  const svcEnv = { MCP_TOKEN: "service-tok" };
  const result = buildServiceEnv(parent, svcEnv);
  assert.equal(result.MCP_TOKEN, "service-tok");
  assert.equal(result.HOME, "/root");
});

test("buildServiceEnv: defaults svcEnv to empty object", () => {
  const parent = { HOME: "/root" };
  const result = buildServiceEnv(parent);
  assert.deepEqual(result, { HOME: "/root" });
});

test("buildServiceEnv: empty parent env yields only svcEnv keys", () => {
  const result = buildServiceEnv({}, { FOO: "bar" });
  assert.deepEqual(result, { FOO: "bar" });
});
