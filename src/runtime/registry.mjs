import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  REGISTRY_FILE,
  ensureRuntimeDirs,
  instanceDir,
  instanceMetaFile,
} from "./paths.mjs";

function now() {
  return new Date().toISOString();
}

function readRegistry() {
  ensureRuntimeDirs();
  if (!existsSync(REGISTRY_FILE)) return { version: 1, instances: {} };
  try {
    const value = JSON.parse(readFileSync(REGISTRY_FILE, "utf8"));
    if (!value || typeof value !== "object" || !value.instances) throw new Error("invalid registry");
    return value;
  } catch (error) {
    throw new Error("runtime registry is unreadable: " + error.message);
  }
}

function writeRegistry(registry) {
  ensureRuntimeDirs();
  const temp = REGISTRY_FILE + "." + process.pid + ".tmp";
  writeFileSync(temp, JSON.stringify(registry, null, 2) + "\n", "utf8");
  renameSync(temp, REGISTRY_FILE);
}

function writeInstanceMeta(instance) {
  ensureRuntimeDirs();
  mkdirSync(instanceDir(instance.id), { recursive: true });
  writeFileSync(instanceMetaFile(instance.id), JSON.stringify(instance, null, 2) + "\n", "utf8");
}

export function listInstances() {
  return Object.values(readRegistry().instances)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function getInstance(id) {
  return readRegistry().instances[id] || null;
}

export function createInstance({ name, configPath }) {
  const registry = readRegistry();
  const duplicate = Object.values(registry.instances).find(item => item.name === name);
  if (duplicate) throw new Error("instance name already exists: " + name);
  const id = "gw_" + randomBytes(8).toString("hex");
  const instance = {
    id,
    name,
    configPath: resolve(configPath),
    status: "stopped",
    pid: null,
    endpoint: null,
    createdAt: now(),
    updatedAt: now(),
  };
  registry.instances[id] = instance;
  writeRegistry(registry);
  writeInstanceMeta(instance);
  return instance;
}

export function updateInstance(id, changes) {
  const registry = readRegistry();
  const instance = registry.instances[id];
  if (!instance) throw new Error("instance not found: " + id);
  Object.assign(instance, changes, { updatedAt: now() });
  registry.instances[id] = instance;
  writeRegistry(registry);
  writeInstanceMeta(instance);
  return instance;
}

export function deleteInstance(id) {
  const registry = readRegistry();
  const instance = registry.instances[id];
  if (!instance) throw new Error("instance not found: " + id);
  delete registry.instances[id];
  writeRegistry(registry);
  // Retain logs for post-mortem inspection. Do not recursively delete user data.
  return instance;
}

export function registryPath() {
  return REGISTRY_FILE;
}
