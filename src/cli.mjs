import { existsSync, readFileSync } from "node:fs";
import { instanceStderrFile, instanceStdoutFile } from "./runtime/paths.mjs";
import { callRuntime } from "./runtime/client.mjs";

const args = process.argv.slice(2);
const command = args[0];

function usage() {
  console.log(`Usage:
  cli2mcp-gateway serve [--config FILE] [--http]
  cli2mcp-gateway list
  cli2mcp-gateway create --name NAME --config FILE [--start]
  cli2mcp-gateway get <id>
  cli2mcp-gateway start|stop|restart <id>
  cli2mcp-gateway update <id> --config FILE
  cli2mcp-gateway rename <id> <name>
  cli2mcp-gateway delete <id>
  cli2mcp-gateway logs <id> [--tail N] [--follow]

serve is the foreground server mode. The other commands manage local
HTTP gateway instances through the runtime daemon.`);
}

function option(name, fallback = undefined) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

function required(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function tail(file, count) {
  if (!existsSync(file)) return "";
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-count).join("\n");
}

function renderLogs(id, count) {
  const stdout = tail(instanceStdoutFile(id), count);
  const stderr = tail(instanceStderrFile(id), count);
  const sections = [];
  if (stdout) sections.push("[stdout]\n" + stdout);
  if (stderr) sections.push("[stderr]\n" + stderr);
  return sections.join("\n") || "(no logs)";
}

async function followLogs(id, count) {
  let last = "";
  while (true) {
    const current = renderLogs(id, count);
    if (current !== last) {
      if (last) process.stdout.write("\x1b[2J\x1b[H");
      console.log(current);
      last = current;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

async function run() {
  if (!command || command === "--help" || command === "-h") {
    usage();
    return;
  }

  // Keep the existing serve entrypoint and argument parser intact.
  if (command === "serve") {
    await import("./server.mjs");
    return;
  }
  if (command === "runtime-daemon") {
    const { runRuntimeDaemon } = await import("./runtime/daemon.mjs");
    await runRuntimeDaemon();
    return;
  }

  if (command === "list") {
    print(await callRuntime("list"));
    return;
  }
  if (command === "create") {
    const created = await callRuntime("create", {
      name: required(option("--name"), "--name is required"),
      configPath: required(option("--config"), "--config is required"),
    });
    if (args.includes("--start")) print(await callRuntime("start", { id: created.id }));
    else print(created);
    return;
  }
  if (["start", "stop", "restart", "delete"].includes(command)) {
    const id = required(args[1], `${command} requires <id>`);
    print(await callRuntime(command, { id }, { autoStart: command !== "stop" && command !== "delete" }));
    return;
  }
  if (command === "get") {
    print(await callRuntime("get", { id: required(args[1], "get requires <id>") }));
    return;
  }
  if (command === "rename") {
    print(await callRuntime("rename", {
      id: required(args[1], "rename requires <id>"),
      name: required(args[2], "rename requires <name>"),
    }));
    return;
  }
  if (command === "update") {
    print(await callRuntime("update", {
      id: required(args[1], "update requires <id>"),
      configPath: required(option("--config"), "--config is required"),
    }));
    return;
  }
  if (command === "logs") {
    const id = required(args[1], "logs requires <id>");
    const count = Number(option("--tail", "100"));
    if (!Number.isInteger(count) || count < 1) throw new Error("--tail must be a positive integer");
    console.log(renderLogs(id, count));
    if (args.includes("--follow")) await followLogs(id, count);
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

run().catch(error => {
  console.error("error: " + error.message);
  process.exitCode = 1;
});
