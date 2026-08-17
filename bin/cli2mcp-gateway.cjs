#!/usr/bin/env node

const { spawn } = require("node:child_process");
const { resolve } = require("node:path");

const entry = resolve(__dirname, "..", "src", "server.mjs");
const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  windowsHide: true,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
