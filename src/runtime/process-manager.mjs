import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";

import { loadBoxConfig } from "../box-config.mjs";
import yaml from "yaml";
import {
  ensureRuntimeDirs,
  instanceDir,
  instanceStderrFile,
  instanceStdoutFile,
} from "./paths.mjs";
import { getInstance, listInstances, updateInstance } from "./registry.mjs";

const execFileAsync = promisify(execFile);
const serverEntry = resolve(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");
const children = new Map();

// Parse a dotenv-style file into a flat {KEY: VALUE} object. Lines starting
// with # and blank lines are ignored. Values are taken verbatim (no $VAR
// expansion, no escape handling) — env_file is for static config, not
// templating. The result is sufficient for env_file: at the service / auth /
// transport level in box.yaml.
function parseEnvFile(path) {
  const result = {};
  if (!existsSync(path)) return result;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) result[m[1]] = m[2];
  }
  return result;
}

// Walk a box.yaml and merge every referenced env_file's contents into a flat
// env map. env_file may appear at three levels:
//   - top-level (docker-compose style: env_file: /etc/foo.env)
//   - per-service (services.<name>.env_file)
//   - auth (auth.env_file — bearer token source)
// The same file may be referenced by multiple sections — later refs overwrite
// earlier ones, which matches the legacy PM2 ecosystem behaviour of applying
// the file's keys after the previous env.
//
// We parse the raw YAML here (not loadBoxConfig's collapsed result) because
// schema validation drops env_file from auth, and box-config collapses
// services.*.env_file into services.*.env — neither preserves the original
// env_file references we need to walk.
export function collectEnvFromBoxConfig(configPath) {
  const env = {};
  let box;
  try {
    box = yaml.parse(readFileSync(configPath, "utf8")) ?? {};
  } catch (error) {
    return env;
  }
  const baseDir = dirname(configPath);
  const resolvePath = (p) => isAbsolute(p) ? p : resolve(baseDir, p);
  const merge = (entries) => {
    const files = Array.isArray(entries) ? entries : (entries ? [entries] : []);
    for (const entry of files) {
      // Match loadBoxConfig's env_file entry shape: string shorthand or
      // {path, required, format} object. We only honour string entries here —
      // object form is rare and loadBoxConfig itself handles it later.
      if (typeof entry !== "string") continue;
      Object.assign(env, parseEnvFile(resolvePath(entry)));
    }
  };
  // docker-compose style: top-level env_file feeds both ${VAR} expansion
  // (handled by box-config) AND child spawn env (handled here).
  merge(box.env_file);
  for (const svc of Object.values(box.services ?? {})) {
    if (svc && typeof svc === "object") merge(svc.env_file);
  }
  if (box.auth && typeof box.auth === "object") merge(box.auth.env_file);
  return env;
}

function endpointForConfig(config) {
  const transport = config.transport;
  if (!transport || !["http", "sse"].includes(transport.type)) {
    throw new Error("runtime instances must use an http or sse transport");
  }
  const host = transport.host === "0.0.0.0" ? "127.0.0.1" : (transport.host || "127.0.0.1");
  const path = transport.path || "/mcp";
  return "http://" + host + ":" + transport.port + path;
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForHealth(config, timeoutMs = 15_000) {
  const healthPath = config.health?.path || "/health";
  const transport = config.transport;
  const host = transport.host === "0.0.0.0" ? "127.0.0.1" : (transport.host || "127.0.0.1");
  const url = "http://" + host + ":" + transport.port + healthPath;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // The gateway may still be discovering upstream tools or binding.
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
  }
  throw new Error("timed out waiting for gateway health: " + url);
}

async function waitForGatewayReady(config, child, timeoutMs = 15_000) {
  let cleanup = () => {};
  const childFailure = new Promise((_, reject) => {
    const onError = error => reject(new Error("gateway process failed: " + error.message));
    const onExit = (code, signal) => reject(new Error(
      `gateway process exited before health check (code=${code ?? "null"}, signal=${signal ?? "none"})`,
    ));
    child.once("error", onError);
    child.once("exit", onExit);
    cleanup = () => {
      child.off("error", onError);
      child.off("exit", onExit);
    };
  });
  try {
    return await Promise.race([waitForHealth(config, timeoutMs), childFailure]);
  } finally {
    cleanup();
  }
}

async function killPid(pid) {
  if (!isAlive(pid)) return;
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    } catch {
      // A concurrent exit is equivalent to a successful stop.
    }
    return;
  }
  try { process.kill(pid, "SIGTERM"); } catch {}
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  if (isAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
}

export async function refreshInstances() {
  const result = [];
  for (const instance of listInstances()) {
    if (instance.pid && !isAlive(instance.pid)) {
      result.push(updateInstance(instance.id, { status: "stopped", pid: null }));
    } else {
      result.push(instance);
    }
  }
  return result;
}

export async function startInstance(id) {
  const instance = getInstance(id);
  if (!instance) throw new Error("instance not found: " + id);
  const { config } = loadBoxConfig(instance.configPath);
  const endpoint = endpointForConfig(config);
  if (instance.pid && isAlive(instance.pid)) {
    return updateInstance(id, { status: "running", endpoint });
  }

  ensureRuntimeDirs();
  mkdirSync(instanceDir(id), { recursive: true });
  const stdout = openSync(instanceStdoutFile(id), "a");
  const stderr = openSync(instanceStderrFile(id), "a");
  const { spawn } = await import("node:child_process");
  // Load every env_file referenced by this instance's box.yaml (services +
  // auth). Without this, box.yaml's env_file values (MCP_TOKEN,
  // ALLOWED_HOSTS, CLI_*, etc.) never reach the child gateway's process.env,
  // so server.mjs's process.env.* fallbacks fail. The collected env sits
  // on top of the daemon's own process.env so the runtime can keep
  // CLI2MCP_RUNTIME_* and the explicit GANG_* exports for ${VAR} expansion.
  const fileEnv = collectEnvFromBoxConfig(instance.configPath);
  const child = spawn(
    process.execPath,
    [serverEntry, "serve", "--config", instance.configPath, "--http"],
    {
      cwd: dirname(instance.configPath),
      detached: true,
      windowsHide: true,
      stdio: ["ignore", stdout, stderr],
      env: {
        ...fileEnv,
        ...process.env,  // daemon's exports (GANG_*, CLI2MCP_RUNTIME_*) win over file values
        CLI2MCP_RUNTIME_INSTANCE_ID: id,
        CLI2MCP_RUNTIME_INSTANCE_NAME: instance.name,
      },
    },
  );
  child.on("error", error => {
    try { updateInstance(id, { status: "failed", pid: null, endpoint, error: error.message }); } catch {}
  });
  closeSync(stdout);
  closeSync(stderr);
  child.unref();
  children.set(id, child);
  updateInstance(id, { status: "starting", pid: child.pid, endpoint });
  try {
    await waitForGatewayReady(config, child);
    return updateInstance(id, { status: "running", pid: child.pid, endpoint });
  } catch (error) {
    await killPid(child.pid);
    children.delete(id);
    updateInstance(id, { status: "failed", pid: null, endpoint, error: error.message });
    throw error;
  }
}

export async function stopInstance(id) {
  const instance = getInstance(id);
  if (!instance) throw new Error("instance not found: " + id);
  if (instance.pid) await killPid(instance.pid);
  children.delete(id);
  return updateInstance(id, { status: "stopped", pid: null });
}

export async function restartInstance(id) {
  await stopInstance(id);
  return startInstance(id);
}
