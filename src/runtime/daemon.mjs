import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

import { loadBoxConfig, configSummary } from "../box-config.mjs";
import { RUNTIME_LOG, RUNTIME_PID, ensureRuntimeDirs } from "./paths.mjs";
import {
  createInstance,
  deleteInstance,
  getInstance,
  listInstances,
  updateInstance,
} from "./registry.mjs";
import {
  refreshInstances,
  restartInstance,
  startInstance,
  stopInstance,
} from "./process-manager.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.CLI2MCP_RUNTIME_PORT || 31990);
let shuttingDown = false;
let operationTail = Promise.resolve();

function log(message) {
  ensureRuntimeDirs();
  appendFileSync(RUNTIME_LOG, new Date().toISOString() + " " + message + "\n", "utf8");
}

function exclusive(fn) {
  const result = operationTail.then(fn);
  operationTail = result.catch(() => {});
  return result;
}

function getDetailedInstance(id) {
  const instance = getInstance(id);
  if (!instance) throw new Error("instance not found: " + id);
  let configText = null;
  let summary = null;
  if (existsSync(instance.configPath)) {
    configText = readFileSync(instance.configPath, "utf8");
    try {
      summary = configSummary(loadBoxConfig(instance.configPath));
    } catch (error) {
      summary = "config error: " + error.message;
    }
  } else {
    summary = "config file not found: " + instance.configPath;
  }
  return { ...instance, configText, summary };
}

async function invoke(method, params = {}) {
  switch (method) {
    case "runtime_status":
      return {
        ok: true,
        pid: process.pid,
        port: PORT,
        registry: listInstances().length,
      };
    case "list":
      return refreshInstances();
    case "get":
      return getDetailedInstance(params.id);
    case "create": {
      if (!params.name || !params.configPath) throw new Error("name and configPath are required");
      const loaded = loadBoxConfig(params.configPath);
      if (loaded.config.transport.type === "stdio") {
        throw new Error("runtime-managed instances require an http or sse transport");
      }
      return createInstance({ name: params.name, configPath: params.configPath });
    }
    case "start":
      return startInstance(params.id);
    case "stop":
      return stopInstance(params.id);
    case "restart":
      return restartInstance(params.id);
    case "rename": {
      if (!params.name) throw new Error("name is required");
      const existing = listInstances().find(item => item.name === params.name);
      if (existing && existing.id !== params.id) throw new Error("instance name already exists: " + params.name);
      return updateInstance(params.id, { name: params.name });
    }
    case "update": {
      if (!params.configPath) throw new Error("configPath is required");
      const loaded = loadBoxConfig(params.configPath);
      if (loaded.config.transport.type === "stdio") {
        throw new Error("runtime-managed instances require an http or sse transport");
      }
      const current = getInstance(params.id);
      if (!current) throw new Error("instance not found: " + params.id);
      const wasRunning = current.status === "running" || Boolean(current.pid);
      if (wasRunning) await stopInstance(params.id);
      const updated = updateInstance(params.id, { configPath: params.configPath, endpoint: null });
      return wasRunning ? startInstance(updated.id) : updated;
    }
    case "delete": {
      const current = getInstance(params.id);
      if (!current) throw new Error("instance not found: " + params.id);
      if (current.pid) await stopInstance(params.id);
      return deleteInstance(params.id);
    }
    default:
      throw new Error("unknown runtime method: " + method);
  }
}

async function handleConnection(socket) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let request;
      try {
        request = JSON.parse(line);
      } catch (error) {
        socket.write(JSON.stringify({ id: null, error: { message: "Invalid JSON: " + error.message } }) + "\n");
        continue;
      }
      exclusive(() => invoke(request.method, request.params || {}))
        .then(result => socket.write(JSON.stringify({ id: request.id ?? null, result }) + "\n"))
        .catch(error => socket.write(JSON.stringify({
          id: request.id ?? null,
          error: { type: error.constructor.name, message: error.message },
        }) + "\n"));
    }
  });
}

export async function runRuntimeDaemon() {
  ensureRuntimeDirs();
  writeFileSync(RUNTIME_PID, String(process.pid) + "\n", "utf8");
  log("runtime daemon starting on " + HOST + ":" + PORT);
  const server = createServer(handleConnection);

  const shutdown = async signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("runtime daemon received " + signal);
    server.close();
    for (const instance of listInstances()) {
      if (instance.pid) {
        try { await stopInstance(instance.id); } catch (error) { log("stop failed: " + error.message); }
      }
    }
    try { unlinkSync(RUNTIME_PID); } catch {}
  };
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, resolvePromise);
  });
  log("runtime daemon ready");
  await new Promise(resolvePromise => server.once("close", resolvePromise));
}

if (process.argv.includes("--foreground")) {
  runRuntimeDaemon().catch(error => {
    log("runtime daemon failed: " + error.stack);
    try { unlinkSync(RUNTIME_PID); } catch {}
    process.exitCode = 1;
  });
}
