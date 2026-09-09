import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const stateRoot = process.env.CLI2MCP_RUNTIME_HOME
  || (process.platform === "win32"
    ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "cli2mcp-gateway")
    : join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "cli2mcp-gateway"));

export const RUNTIME_ROOT = stateRoot;
export const INSTANCE_ROOT = join(RUNTIME_ROOT, "instances");
export const RUNTIME_LOG = join(RUNTIME_ROOT, "runtime.log");
export const RUNTIME_PID = join(RUNTIME_ROOT, "runtime.pid");
export const REGISTRY_FILE = join(RUNTIME_ROOT, "registry.json");

export function instanceDir(id) {
  return join(INSTANCE_ROOT, id);
}

export function instanceMetaFile(id) {
  return join(instanceDir(id), "instance.json");
}

export function instanceStdoutFile(id) {
  return join(instanceDir(id), "stdout.log");
}

export function instanceStderrFile(id) {
  return join(instanceDir(id), "stderr.log");
}

export function ensureRuntimeDirs() {
  mkdirSync(INSTANCE_ROOT, { recursive: true });
}
