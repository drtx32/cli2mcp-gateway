import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { RUNTIME_PID } from "./paths.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.CLI2MCP_RUNTIME_PORT || 31990);
const daemonEntry = resolve(dirname(fileURLToPath(import.meta.url)), "daemon.mjs");

function request(method, params = {}, timeoutMs = 30_000) {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection({ host: HOST, port: PORT });
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("runtime daemon request timed out")), timeoutMs);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolvePromise(result);
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(JSON.stringify({ id: 1, method, params }) + "\n");
    });
    socket.on("data", chunk => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index === -1) return;
      try {
        const response = JSON.parse(buffer.slice(0, index));
        if (response.error) finish(new Error(response.error.message || "runtime daemon error"));
        else finish(null, response.result);
      } catch (error) {
        finish(error);
      }
    });
    socket.on("error", error => finish(error));
    socket.on("close", () => {
      if (!settled) finish(new Error("runtime daemon closed the connection"));
    });
  });
}

async function waitUntilReady(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await request("runtime_status", {}, 1000);
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
    }
  }
  throw new Error("timed out waiting for runtime daemon: " + (lastError?.message || "unknown error"));
}

function spawnDaemon() {
  const child = spawn(process.execPath, [daemonEntry, "--foreground"], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();
}

export async function ensureDaemon() {
  try {
    await request("runtime_status");
    return;
  } catch {}
  spawnDaemon();
  await waitUntilReady();
}

export async function callRuntime(method, params, { autoStart = true } = {}) {
  if (autoStart) await ensureDaemon();
  return request(method, params);
}

export { HOST as RUNTIME_HOST, PORT as RUNTIME_PORT, RUNTIME_PID };
