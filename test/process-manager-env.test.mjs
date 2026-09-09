import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { collectEnvFromBoxConfig } from "../src/runtime/process-manager.mjs";

// Regression: gangtise-mcp.yaml declares its credentials at the **top**
// level (docker-compose style `env_file:`), not under services.*.env_file.
// process-manager.mjs's collectEnvFromBoxConfig must merge those keys into
// the child gateway's spawn env — otherwise the gateway falls back to a
// default ALLOWED_HOSTS check and rejects Host: gangtise.tong-xiao.top
// with 403 "Invalid Host".

function writeEnvFile(dir, name, lines) {
  const p = join(dir, name);
  writeFileSync(p, lines.join("\n") + "\n", "utf8");
  return p;
}

test("collectEnvFromBoxConfig: merges top-level env_file (docker-compose style)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pmgr-env-top-"));
  try {
    const envPath = writeEnvFile(dir, "box.env", [
      "ALLOWED_HOSTS=gangtise.tong-xiao.top,127.0.0.1,localhost",
      "PORT=25426",
      "HOST=127.0.0.1",
      "GANGTISE_ACCESS_KEY=AK",
      "GANGTISE_SECRET_KEY=SK",
    ]);
    const yamlPath = join(dir, "box.yaml");
    writeFileSync(yamlPath, [
      "name: test",
      "env_file:",
      `  - ${envPath}`,
      "services:",
      "  gangtise:",
      "    adapter: mcp-http",
      "    url: https://example.com/mcp/",
      "transport:",
      "  type: http",
      "  host: 127.0.0.1",
      "  port: 25426",
      "auth:",
      "  mode: bearer",
      "  env_file:",
      `    - ${envPath}`, // also referenced by auth, should not lose top-level keys
    ].join("\n"), "utf8");

    const env = collectEnvFromBoxConfig(yamlPath);
    assert.equal(env.ALLOWED_HOSTS, "gangtise.tong-xiao.top,127.0.0.1,localhost");
    assert.equal(env.PORT, "25426");
    assert.equal(env.HOST, "127.0.0.1");
    assert.equal(env.GANGTISE_ACCESS_KEY, "AK");
    assert.equal(env.GANGTISE_SECRET_KEY, "SK");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectEnvFromBoxConfig: merges services.*.env_file (legacy style)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pmgr-env-svc-"));
  try {
    const svcEnv = writeEnvFile(dir, "svc.env", ["SVC_KEY=from-service"]);
    const yamlPath = join(dir, "box.yaml");
    writeFileSync(yamlPath, [
      "name: test",
      "services:",
      "  cli:",
      "    adapter: cli",
      "    command: [ashare]",
      `    env_file: [${svcEnv}]`,
      "transport:",
      "  type: http",
      "  host: 127.0.0.1",
      "  port: 25422",
    ].join("\n"), "utf8");

    const env = collectEnvFromBoxConfig(yamlPath);
    assert.equal(env.SVC_KEY, "from-service");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectEnvFromBoxConfig: merges auth.env_file (bearer token source)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pmgr-env-auth-"));
  try {
    const authEnv = writeEnvFile(dir, "bearer.env", ["MCP_TOKEN=tok-abc"]);
    const yamlPath = join(dir, "box.yaml");
    writeFileSync(yamlPath, [
      "name: test",
      "services:",
      "  cli:",
      "    adapter: cli",
      "    command: [ashare]",
      "transport:",
      "  type: http",
      "  host: 127.0.0.1",
      "  port: 25422",
      "auth:",
      "  mode: bearer",
      `  env_file: [${authEnv}]`,
    ].join("\n"), "utf8");

    const env = collectEnvFromBoxConfig(yamlPath);
    assert.equal(env.MCP_TOKEN, "tok-abc");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectEnvFromBoxConfig: returns {} on missing config file (does not throw)", () => {
  // Spawning an instance whose config was deleted shouldn't crash the daemon.
  const env = collectEnvFromBoxConfig("/nonexistent/box.yaml");
  assert.deepEqual(env, {});
});