import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { promisify } from "node:util";

import { loadBoxConfig } from "../box-config.mjs";
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
  const child = spawn(
    process.execPath,
    [serverEntry, "serve", "--config", instance.configPath, "--http"],
    {
      cwd: dirname(instance.configPath),
      detached: true,
      windowsHide: true,
      stdio: ["ignore", stdout, stderr],
      env: {
        ...process.env,
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
    await waitForHealth(config);
    return updateInstance(id, { status: "running", pid: child.pid, endpoint });
  } catch (error) {
    await killPid(child.pid);
    children.delete(id);
    updateInstance(id, { status: "failed", pid: null, endpoint });
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
