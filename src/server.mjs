// cli2mcp-gateway — 双 transport MCP server
//
// Modes:
//   serve                 Stdio transport (本地 brain + 任意 MCP-aware agent)
//   serve --http          HTTP transport (远程共享 + Bearer/OAuth/Auth0)
//
// Architecture:
//   - 业务层 (createServer) 100% 复用
//   - 下游 CLI: 由 src/help-parser.js 内嵌的 schema 推断 + 直接 execa spawn
//     (不再嵌套 cli2mcp npm 包,所有 subcommand 各暴露为独立 MCP tool)
//   - HTTP 路径叠加 OAuth + Bearer + Rate limit + CORS + IP allowlist
//   - stdio 路径叠加 parent-process watchdog + idle timeout

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import express from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { execa } from "execa";
import { discoverTools, buildArgv } from "./help-parser.js";
import { loadBoxConfig, legacyEnvConfig, configSummary } from "./box-config.mjs";
import { aggregateTools, buildDispatchTable, resolveToolCall } from "./tool-aggregator.mjs";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ===== 1. 环境变量解析(单一来源) =====
const env = {
  PORT:              Number(process.env.PORT || 3100),
  HOST:              process.env.HOST || "127.0.0.1",
  AUTH_MODE:         process.env.AUTH_MODE || "bearer",          // bearer | oauth | both
  MCP_TOKEN:         process.env.MCP_TOKEN || "",
  PUBLIC_ENDPOINT:   (process.env.PUBLIC_ENDPOINT || "").replace(/\/$/, ""),
  OAUTH_ISSUER:      (process.env.OAUTH_ISSUER || "").replace(/\/$/, ""),
  AUTH0_ISSUER:      (process.env.AUTH0_ISSUER || "").replace(/\/$/, ""),
  AUTH0_AUDIENCE:    process.env.AUTH0_AUDIENCE || "",
  AUTH0_REQ_SCOPE:   process.env.AUTH0_REQUIRED_SCOPE || "parsehub:use",
  // OAuth 2.1 password grant uses OAUTH_USERNAME / OAUTH_PASSWORD. We refuse
// to fall back to a default credential — it would make every gateway with
// `AUTH_MODE=oauth` accidentally share the same admin login. Operators must
// set OAUTH_PASSWORD (and ideally OAUTH_USERNAME) explicitly or stick with
// AUTH_MODE=bearer. Check is lazy and only fires when oauth is actually used.
  OAUTH_USERNAME:    process.env.OAUTH_USERNAME || "admin",
  OAUTH_PASSWORD:    process.env.OAUTH_PASSWORD || "", // Empty default; validated below in `resolveOAuthPassword()`.
  ALLOWED_HOSTS:     (process.env.ALLOWED_HOSTS || "").split(",").map(v => v.trim()).filter(Boolean),
  // IP allowlist. Comma-separated, accepts bare IP or IP:port.
  // Examples: "161.33.195.100" or "161.33.195.100:3101,10.0.0.0/8".
  // Empty = allow all (rely on bearer / OAuth alone).
  ALLOWED_IPS:       (process.env.MCP_ALLOWED_IPS || process.env.ALLOWED_IPS || "").split(",").map(v => v.trim()).filter(Boolean),
  CORS_ORIGINS:      (process.env.CORS_ORIGINS || "").split(",").map(v => v.trim()).filter(Boolean),
  RATE_LIMIT_RPS:    Number(process.env.RATE_LIMIT_RPS || 20),    // 每 IP 每秒
  RATE_LIMIT_BURST:  Number(process.env.RATE_LIMIT_BURST || 40),
  // Downstream CLI: directly spawned by the gateway (no nested cli2mcp npm
  // package). CLI2MCP_SUBCOMMANDS optionally constrains which subcommands
  // are exposed (comma-separated). Empty = auto-discover from `--help`.
  CLI_COMMAND:       process.env.CLI_COMMAND || process.env.CLI2MCP_COMMAND || "rg",
  CLI_CWD:           resolve(process.env.CLI_CWD || process.env.CLI2MCP_CWD || process.cwd()),
  CLI_SUBCOMMANDS:   (process.env.CLI_SUBCOMMANDS || process.env.CLI2MCP_SUBCOMMANDS || "")
                      .split(",").map(v => v.trim()).filter(Boolean),
  CLI_TIMEOUT_MS:    Number(process.env.CLI_TIMEOUT_MS || 60_000),
  CLI_MAX_OUTPUT_BYTES: Number(process.env.CLI_MAX_OUTPUT_BYTES || 16_000),
  // When true, only expose `<cli>_help` and `<cli>_run`. Skip the recursive
  // per-subcommand tool expansion. Useful for CLIs whose top-level subcommands
  // are just command groupings (e.g. `multica issue create`) and where per-tool
  // schema inference yields empty/incorrect schemas.
  CLI_DUAL_TOOL_MODE: ["1", "true", "yes"].includes(String(process.env.CLI_DUAL_TOOL_MODE || "").toLowerCase()),
  // stdio-only
  STDIO_IDLE_TIMEOUT_SEC: Number(process.env.STDIO_IDLE_TIMEOUT_SEC || 0),
  STDIO_BOOT_TIMEOUT_SEC: Number(process.env.STDIO_BOOT_TIMEOUT_SEC || 0),
};

if (!["bearer", "oauth", "both"].includes(env.AUTH_MODE)) {
  console.error(`AUTH_MODE must be bearer | oauth | both, got "${env.AUTH_MODE}"`);
  process.exit(1);
}

if (!env.PUBLIC_ENDPOINT) {
  env.PUBLIC_ENDPOINT = `http://${env.HOST}:${env.PORT}`;
}
if (!env.OAUTH_ISSUER) {
  env.OAUTH_ISSUER = env.PUBLIC_ENDPOINT;
}

// Token: 优先级 MCP_TOKEN > AUTH_MODE=oauth 时空 > 随机
// Override env values with box config (only for fields box config actually
// owns). This keeps the rest of the file reading `env.PORT` / `env.HOST`
// etc. without having to thread box.config through every middleware.
// Anything not in box config keeps reading from env (legacy mode).
//
// NOTE: this runs only when actually serving (not for `config check/list`
// subcommands which exit earlier). It must come AFTER `let box = ...`.
function applyBoxConfigToEnv(box) {
  if (box.config.transport?.type && box.config.transport.type !== "stdio") {
    env.PORT = box.config.transport.port;
    env.HOST = box.config.transport.host || "127.0.0.1";
  }
  if (box.config.auth) {
    if (box.config.auth.mode) env.AUTH_MODE = box.config.auth.mode;
    if (box.config.auth.token) env.MCP_TOKEN = box.config.auth.token;
  }
  if (box.config.rate_limit) {
    env.RATE_LIMIT_RPS = box.config.rate_limit.rps ?? env.RATE_LIMIT_RPS;
    env.RATE_LIMIT_BURST = box.config.rate_limit.burst ?? env.RATE_LIMIT_BURST;
  }
  if (box.config.cors) {
    env.CORS_ORIGINS = (box.config.cors.origins || []);
  }
  if (box.config.ip_allowlist && box.config.ip_allowlist.length > 0) {
    // Map ip_allowlist onto the legacy ALLOWED_IPS so the existing middleware
    // continues to work without changes.
    env.ALLOWED_IPS = box.config.ip_allowlist;
  }
  if (box.config.health?.path) {
    env.HEALTH_PATH = box.config.health.path;
  }
}

env.TOKEN = env.MCP_TOKEN
  || (env.AUTH_MODE === "oauth" ? "" : randomBytes(24).toString("base64url"));

// OAuth 需要 https(本地例外)
const oauthNeeded = ["oauth", "both"].includes(env.AUTH_MODE) || Boolean(env.AUTH0_ISSUER);
if (oauthNeeded && !env.PUBLIC_ENDPOINT.startsWith("https://")
    && env.HOST !== "127.0.0.1" && env.HOST !== "localhost") {
  console.error("OAuth public deployments require PUBLIC_ENDPOINT=https://...");
  process.exit(1);
}
// Lazy validation of OAUTH_PASSWORD — only fail when OAuth flow actually runs.
if (oauthNeeded && env.AUTH_MODE !== "both" && !Boolean(env.AUTH0_ISSUER)
    && (!env.OAUTH_PASSWORD || env.OAUTH_PASSWORD.length === 0)) {
  console.error("[boot] OAUTH_PASSWORD not set. Refusing to start with insecure default. " +
    "Either set OAUTH_PASSWORD (and OAUTH_USERNAME) in the environment, " +
    "or use AUTH_MODE=bearer / AUTH_MODE=both (no password required).");
  process.exit(1);
}

// ===== 2. CLI 子命令路由 =====
const argv = process.argv.slice(2);
const subcmd = argv[0];

if (!subcmd || subcmd === "--help" || subcmd === "-h") {
  console.log(`Usage:
  node src/server.mjs serve              # Stdio transport (本地)
  node src/server.mjs serve --http       # HTTP transport (远程)
  node src/server.mjs serve --stdio      # 等同于 serve (显式)

Env:
  PORT              HTTP listen port (default 3100)
  HOST              HTTP listen host (default 127.0.0.1)
  AUTH_MODE         bearer | oauth | both (default bearer)
  MCP_TOKEN         static bearer token (default random per boot)
  PUBLIC_ENDPOINT   public https URL (required for OAuth mode)
  CLI_COMMAND       downstream CLI binary (default rg)
  CLI_CWD           working directory passed to the CLI
  CLI_SUBCOMMANDS   optional comma-separated list of subcommands to expose
  CLI_TIMEOUT_MS    per-call CLI timeout (default 60s)
  CLI_MAX_OUTPUT_BYTES  per-call stdout byte cap before truncation (default 16 KB). The synthetic help tool is exempt.
  CLI_DUAL_TOOL_MODE 1|true|yes — skip recursive subcommand tool expansion. Only expose `<cli>_help` and `<cli>_run` (the latter executes any subcommand via commandPath+args). Useful when top-level subcommands are command groupings (e.g. multica issue create) and per-tool schema inference yields empty schemas.
  ALLOWED_HOSTS     Host header allowlist (anti-DNS-rebinding)
  MCP_ALLOWED_IPS   source-IP allowlist (comma-separated; bare IP, IP:port, CIDR)
  CORS_ORIGINS      comma-separated allowed origins
  RATE_LIMIT_RPS    per-IP rate (default 20)
  RATE_LIMIT_BURST  burst size (default 40)
  STDIO_IDLE_TIMEOUT_SEC  stdio path idle exit
  STDIO_BOOT_TIMEOUT_SEC  stdio path boot deadline
`);

  // yaml config-mode help (printed when --config flag is referenced but no subcommand).
  console.log(`
Config file mode:
  node src/server.mjs serve --config /path/to/box.yaml [--http|--stdio] [--env-dir DIR]

  --config PATH    load a multi-service box from a YAML file (recommended)
  --env-dir DIR    base dir for relative env_file paths (default: dir of --config)
  --http | --stdio transport (default: from config; falls back to stdio)

  node src/server.mjs config check --config /path/to/box.yaml    validate + summarize
  node src/server.mjs config list  --config /path/to/box.yaml    print merged services

The legacy single-CLI mode (CLI_COMMAND / CLI_CWD / CLI_SUBCOMMANDS env)
remains supported when --config is omitted.
`);
  process.exit(0);
}

if (subcmd === "config") {
  // Subcommand: config check / config list. Always exits; never starts a server.
  const subsub = argv[1];
  const configFlagIdx = argv.indexOf("--config");
  if (configFlagIdx === -1 || !argv[configFlagIdx + 1]) {
    console.error("config subcommand requires --config <path>");
    process.exit(1);
  }
  const configPath = argv[configFlagIdx + 1];
  let box;
  try {
    box = loadBoxConfig(configPath, { envDir: argv[argv.indexOf("--env-dir") + 1] || undefined });
  } catch (err) {
    console.error(String(err.message || err));
    process.exit(2);
  }
  if (subsub === "check") {
    console.log(`ok: ${Object.keys(box.config.services).length} services, ${box.config.transport.type} transport`);
    console.log(configSummary(box));
    process.exit(0);
  }
  if (subsub === "list") {
    for (const [name, svc] of Object.entries(box.config.services)) {
      console.log(`service: ${name}`);
      console.log(`  adapter:  ${svc.adapter}`);
      if (svc.adapter === "cli") console.log(`  command:  ${svc.command}`);
      if (svc.adapter === "mcp-http") console.log(`  url:      ${svc.url}`);
      if (svc.adapter === "openapi") console.log(`  base_url: ${svc.base_url}`);
    }
    process.exit(0);
  }
  console.error(`unknown config subcommand: ${subsub}`);
  process.exit(1);
}

if (subcmd !== "serve") {
  console.error(`unknown subcommand: ${subcmd}`);
  process.exit(1);
}

// ---- --config / legacy branch ----
// If --config is given, load multi-service box config. Otherwise derive
// a single-service box from legacy env vars (CLI_COMMAND / CLI_CWD / ...).
const argvSet = new Set(argv);
let box;
{
  const configFlagIdx = argv.indexOf("--config");
  if (configFlagIdx !== -1) {
    const configPath = argv[configFlagIdx + 1];
    if (!configPath) {
      console.error("--config requires a path argument");
      process.exit(1);
    }
    const envDirIdx = argv.indexOf("--env-dir");
    box = loadBoxConfig(configPath, {
      envDir: envDirIdx !== -1 ? argv[envDirIdx + 1] : undefined,
    });
  } else {
    box = { path: null, config: legacyEnvConfig() };
  }
}

const wantHttp = argv.includes("--http") || box.config.transport.type === "http" || box.config.transport.type === "sse";
const wantStdio = argv.includes("--stdio") || box.config.transport.type === "stdio";
// 不允许同时开两种 transport
if (argv.includes("--http") && argv.includes("--stdio")) {
  console.error("Cannot use both --http and --stdio at the same time");
  process.exit(1);
}

// Apply box config to env (HTTP transport / auth / rate / cors / ip / health).
// We do this here (just after `let box = ...` and the transport validation)
// so the legacy env-only paths below keep reading from env while the new
// config-file path gets the configured values.
applyBoxConfigToEnv(box);

// ===== 3. 共用层:多 service 工具发现 + 聚合 =====
//
// For each service in the box config, run the adapter's discover() to
// collect its tools. We then merge them under a single namespace (see
// tool-aggregator.mjs). One MCP tool per leaf across all services.
//
// STDIO_BOOT_TIMEOUT_SEC only applies to the initial discovery phase
// (default: 0 = wait forever; we don't want to crash-loop the gateway if
// a service is slow to print --help).

env.STDIO_BOOT_TIMEOUT_SEC = env.STDIO_BOOT_TIMEOUT_SEC ?? 0;

let bootTimeoutHandle = null;
if (env.STDIO_BOOT_TIMEOUT_SEC > 0) {
  bootTimeoutHandle = setTimeout(() => {
    console.error(`[boot] service discovery exceeded ${env.STDIO_BOOT_TIMEOUT_SEC}s — exiting non-zero`);
    process.exit(2);
  }, env.STDIO_BOOT_TIMEOUT_SEC * 1000);
}

/** @type {Record<string, Array<{name: string, description: string, inputSchema: object, dispatch?: object}>>} */
const perServiceTools = {};
/** @type {Record<string, { callTool: (name: string, args: any) => Promise<any>, close: () => Promise<void> }>} */
const perServiceCallers = {};

async function discoverStdioMcpTools(serviceName, command, args, env, cwd) {
  const transport = new StdioClientTransport({
    command,
    args: args || [],
    env: { ...process.env, ...(env || {}) },
    cwd: cwd || process.cwd(),
    stderr: "inherit",  // forward to our stderr; prevents pipe-buffer deadlock
  });
  const client = new McpClient(
    { name: `cli2mcp-gateway-bridge/${serviceName}`, version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  const { tools } = await client.listTools();
  // Map MCP tool format into the aggregator-friendly format. Dispatch goes
  // through `perServiceCallers[serviceName].callTool`.
  return { client, tools: tools.map(t => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema ?? { type: "object", properties: {} },
  })) };
}

for (const [serviceName, svc] of Object.entries(box.config.services)) {
  console.error(`[boot] discovering service: ${serviceName} (adapter=${svc.adapter})`);
  if (svc.adapter === "cli") {
    const subcmds = svc.subcommands && svc.subcommands.length > 0 ? svc.subcommands : null;
    // dual_tool_mode can be set on the service directly (preferred) or via
    // the legacy env-var path (which synthesises a single-service box).
    let dualMode = false;
    let skipRec = false;
    if (typeof svc.dual_tool_mode === "boolean") {
      dualMode = svc.dual_tool_mode;
    } else if (svc.__legacy && typeof svc.__legacy.CLI_DUAL_TOOL_MODE === "boolean") {
      dualMode = svc.__legacy.CLI_DUAL_TOOL_MODE;
    }
    if (typeof svc.skip_recursive === "boolean") {
      skipRec = svc.skip_recursive;
    }
    perServiceTools[serviceName] = await discoverTools(
      svc.command,
      subcmds,
      { dualToolMode: dualMode, skipRecursive: skipRec, cwd: svc.cwd },
    );
  } else if (svc.adapter === "mcp-stdio") {
    const { client, tools } = await discoverStdioMcpTools(
      serviceName,
      svc.command,
      svc.args || [],
      svc.env || {},
      svc.cwd,
    );
    perServiceTools[serviceName] = tools;
    perServiceCallers[serviceName] = {
      callTool: async (name, args) => client.callTool({ name, arguments: args ?? {} }),
      close: () => client.close(),
    };
  } else {
    console.error(`[boot] adapter "${svc.adapter}" not yet implemented (service: ${serviceName})`);
    process.exit(1);
  }
}
if (bootTimeoutHandle) clearTimeout(bootTimeoutHandle);

const aggTools = aggregateTools(perServiceTools, box.config.naming);
const toolDispatch = buildDispatchTable(aggTools);
const tools = aggTools;

if (tools.length === 0) {
  console.error(`[boot] no tools discovered across ${Object.keys(box.config.services).length} service(s). Does each CLI support --help?`);
  process.exit(1);
}
const allowedTools = new Set(tools.map((tool) => tool.name));
const toolByName = new Map(tools.map(tool => [tool.name, tool]));

// 共用业务层:无论 stdio 还是 http 都用这个 createServer
function createServer() {
  const server = new Server(
    { name: "cli2mcp-gateway", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: callArgs = {} } = request.params;
    const tool = toolByName.get(name);
    if (!tool) throw new Error(`Tool not allowlisted: ${name}`);

    // Look up the owning service from the dispatch table so per-call
    // dispatch (CLI command, cwd, timeout, env) comes from box config.
    const dispatch = toolDispatch.get(name);
    if (!dispatch) throw new Error(`Tool dispatch missing: ${name}`);
    const svc = box.config.services[dispatch.serviceName];
    if (!svc) throw new Error(`Service not found for tool ${name}: ${dispatch.serviceName}`);
    const serviceCwd = svc.cwd || env.CLI_CWD;
    const serviceTimeout = svc.timeout_ms || env.CLI_TIMEOUT_MS;
    const serviceMaxBytes = svc.max_output_bytes || env.CLI_MAX_OUTPUT_BYTES;
    const serviceEnv = { ...process.env, ...(svc.env || {}) };

    // mcp-stdio adapter: forward the call through the per-service MCP client
    // we set up at boot. No subprocess spawn here — the stdio MCP server is
    // already running, we just round-trip the JSON-RPC.
    if (svc.adapter === "mcp-stdio") {
      const caller = perServiceCallers[dispatch.serviceName];
      if (!caller) {
        throw new Error(`MCP client missing for service ${dispatch.serviceName}`);
      }
      const result = await caller.callTool(tool.originalName, callArgs);
      // Apply the same output-byte cap as for CLI tools so a runaway upstream
      // can't blow up our response size.
      let text = (result.content || [])
        .map(c => c.type === "text" ? c.text : `[${c.type}]`)
        .join("\n");
      if (text.length > serviceMaxBytes) {
        const hint = `\n\n[TRUNCATED: output was ${text.length} bytes, only first ${serviceMaxBytes} shown.]`;
        text = text.slice(0, serviceMaxBytes) + hint;
      }
      return {
        content: [{ type: "text", text }],
        isError: Boolean(result.isError),
      };
    }

    // Synthetic "help" tool: run `<cli> [sub] --help [extra args]` and return
    // raw text. This is the agent's primary way to discover what's available
    // without burning output budget on broad enumeration tools.
    if (tool.dispatch && tool.dispatch.kind === "help") {
      const argv = [];
      const commandPath = Array.isArray(callArgs.commandPath) && callArgs.commandPath.length > 0
        ? callArgs.commandPath
        : (typeof callArgs.sub === "string" && callArgs.sub ? [callArgs.sub] : []);
      if (commandPath.length > 0) argv.push(...commandPath);
      argv.push("--help");
      if (Array.isArray(callArgs.args)) argv.push(...callArgs.args);
      const r = await execa(svc.command, argv, {
        cwd: serviceCwd,
        timeout: serviceTimeout,
        reject: false,
        env: serviceEnv,
      });
      const commandPathText = commandPath.length > 0 ? ` ${commandPath.join(" ")}` : "";
      const text = (r.stdout || r.stderr || "").trim()
        || `(${svc.command}${commandPathText} --help produced no output)`;
      const target = `${svc.command}${commandPathText} --help`;
      const header = [
        `Help for ${svc.command}${commandPathText}.`,
        `Use this meta-tool to inspect the CLI, or pass "commandPath" (preferred) or "sub" plus "args" to drill down into a command help page.`,
        `Raw output from ${target}:`,
      ].join("\n");
      return { content: [{ type: "text", text: `${header}\n\n${text}` }] };
    }

    // Synthetic "run" tool (dual-tool mode): execute `<cli> <commandPath...> <args...>`
    // verbatim, no --help appended. Lets the agent reach nested subcommands that
    // per-tool schema inference can't represent.
    if (tool.dispatch && tool.dispatch.kind === "run") {
      const argv = [];
      const commandPath = Array.isArray(callArgs.commandPath) ? callArgs.commandPath : [];
      if (commandPath.length > 0) argv.push(...commandPath);
      if (Array.isArray(callArgs.args)) argv.push(...callArgs.args);
      const r = await execa(svc.command, argv, {
        cwd: serviceCwd,
        timeout: serviceTimeout,
        reject: false,
        env: serviceEnv,
        input: typeof callArgs.stdin === "string" ? callArgs.stdin : undefined,
      });
      if (r.exitCode !== 0) {
        const errText = (r.stderr || r.stdout || "").trim();
        return {
          isError: true,
          content: [{ type: "text", text: `Command failed (exit ${r.exitCode})${errText ? `: ${errText}` : ""}` }],
        };
      }
      let text = r.stdout || "";
      if (text.length > serviceMaxBytes) {
        const hint = `\n\n[TRUNCATED: output was ${text.length} bytes, only first ${serviceMaxBytes} shown. Re-run with a narrower scope to get a smaller result.]`;
        text = text.slice(0, serviceMaxBytes) + hint;
      }
      return { content: [{ type: "text", text }] };
    }

    const argv = [];
    const commandPath = Array.isArray(tool.dispatch.commandPath)
      ? tool.dispatch.commandPath
      : (tool.dispatch.subcommand ? [tool.dispatch.subcommand] : []);
    if (commandPath.length > 0) argv.push(...commandPath);
    argv.push(...buildArgv(tool.dispatch.shape, callArgs));
    const r = await execa(svc.command, argv, {
        cwd: serviceCwd,
        timeout: serviceTimeout,
        reject: false,
        env: serviceEnv,
        input: typeof callArgs.stdin === "string" ? callArgs.stdin : undefined,
      }
    );
    if (r.exitCode !== 0) {
      const errText = (r.stderr || r.stdout || "").trim();
      return {
        isError: true,
        content: [{ type: "text", text: `Command failed (exit ${r.exitCode})${errText ? `: ${errText}` : ""}` }],
      };
    }

    // Truncate very large stdout. Help tool already short-circuited above and
    // is exempt; every other tool gets the same budget.
    let text = r.stdout || "";
    if (text.length > serviceMaxBytes) {
      const hint = `\n\n[TRUNCATED: output was ${text.length} bytes, only first ${serviceMaxBytes} shown. Re-run with a narrower scope — e.g. pass a specific subcommand to the help tool, or target a single item — to get a smaller result.]`;
      text = text.slice(0, serviceMaxBytes) + hint;
    }
    return { content: [{ type: "text", text }] };
  });
  return server;
}

// ===== 4. transport:stdio =====

async function runStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 父进程看门狗:父进程死了就自杀(防独占资源 / orphan)
  const parentCheckInterval = setInterval(() => {
    if (process.ppid === 1) {
      console.error("[stdio] parent process gone — exiting");
      process.exit(0);
    }
  }, 5_000);
  parentCheckInterval.unref();

  // stdin EOF → 优雅退出
  process.stdin.on("end", () => {
    console.error("[stdio] stdin EOF — shutting down");
    process.exit(0);
  });

  // 空闲超时(可选):长期无 request → 退出
  if (env.STDIO_IDLE_TIMEOUT_SEC > 0) {
    let idleTimer = setTimeout(() => {
      console.error(`[stdio] idle ${env.STDIO_IDLE_TIMEOUT_SEC}s — shutting down`);
      process.exit(0);
    }, env.STDIO_IDLE_TIMEOUT_SEC * 1000);
    idleTimer.unref();

    // 任何 request 进来重置定时器(简化版:监听 stdin 数据)
    process.stdin.on("data", () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        console.error(`[stdio] idle ${env.STDIO_IDLE_TIMEOUT_SEC}s — shutting down`);
        process.exit(0);
      }, env.STDIO_IDLE_TIMEOUT_SEC * 1000);
      idleTimer.unref();
    });
  }

  // 优雅退出
  const shutdown = async (signal) => {
    console.error(`[stdio] received ${signal} — shutting down`);
    clearInterval(parentCheckInterval);
    await server.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.error(`[stdio] cli2mcp-gateway (stdio) — tools=${[...allowedTools].join(", ")}`);
}

// ===== 5. transport:http =====

async function runHttp() {
  // ----- 5.1 OAuth / Auth0 state -----
  const oauthClients = new Map();
  const authorizationCodes = new Map();
  const oauthTokens = new Map();

  function hashVerifier(v) { return createHash("sha256").update(v).digest("base64url"); }
  function safeEqual(left, right) {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  function validRedirectUris(uris) {
    return Array.isArray(uris) && uris.length > 0 && uris.every(u => {
      try {
        const url = new URL(u);
        return url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
      } catch { return false; }
    });
  }
  function issueAccessToken(clientId, scope = "tools:read tools:write") {
    const token = randomBytes(32).toString("base64url");
    oauthTokens.set(token, { clientId, scope, expiresAt: Date.now() + 3600_000 });
    return token;
  }

  const auth0Jwks = env.AUTH0_ISSUER
    ? createRemoteJWKSet(new URL(`${env.AUTH0_ISSUER}/.well-known/jwks.json`))
    : null;

  async function auth0Authorized(supplied) {
    if (!auth0Jwks || !env.AUTH0_AUDIENCE) return false;
    try {
      const { payload } = await jwtVerify(supplied, auth0Jwks, {
        issuer: `${env.AUTH0_ISSUER}/`,
        audience: env.AUTH0_AUDIENCE,
      });
      const scopes = String(payload.scope || "").split(/\s+/).filter(Boolean);
      return scopes.includes(env.AUTH0_REQ_SCOPE);
    } catch (error) {
      console.warn(`Auth0 token rejected: ${error.code || error.message}`);
      return false;
    }
  }

  async function authorized(req, res) {
    const header = req.headers.authorization || "";
    const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
    const bearerOk = ["bearer", "both"].includes(env.AUTH_MODE) && env.TOKEN && safeEqual(supplied, env.TOKEN);
    const oauthToken = oauthTokens.get(supplied);
    const oauthOk = oauthNeeded && oauthToken && oauthToken.expiresAt > Date.now();
    const auth0Ok = await auth0Authorized(supplied);
    if (!bearerOk && !oauthOk && !auth0Ok) {
      const metadata = `${env.PUBLIC_ENDPOINT}/.well-known/oauth-protected-resource`;
      const challenge = oauthNeeded
        ? `Bearer realm="cli2mcp-gateway", resource_metadata="${metadata}"`
        : `Bearer realm="cli2mcp-gateway"`;
      res.status(401).set("WWW-Authenticate", challenge).json({ error: "unauthorized" });
      return false;
    }
    return true;
  }

  // ----- 5.2 Express app -----
  const app = createMcpExpressApp({
    host: env.HOST,
    ...(env.ALLOWED_HOSTS.length ? { allowedHosts: env.ALLOWED_HOSTS } : {}),
  });
  app.use(express.urlencoded({ extended: false }));

  // CORS(显式 allowlist)
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (env.CORS_ORIGINS.length === 0 || env.CORS_ORIGINS.includes(origin))) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
      res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
      res.set("Access-Control-Expose-Headers", "Mcp-Session-Id");
      res.set("Access-Control-Max-Age", "86400");
    }
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });

  // Rate limit(per-IP token bucket,内存实现,不引外部依赖)
  const rateBuckets = new Map();
  const healthPath = env.HEALTH_PATH || "/health";
  app.use((req, res, next) => {
    if (req.path === healthPath) return next();  // health 不限流
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    let bucket = rateBuckets.get(ip);
    if (!bucket) {
      bucket = { tokens: env.RATE_LIMIT_BURST, lastRefill: now };
      rateBuckets.set(ip, bucket);
    }
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(env.RATE_LIMIT_BURST, bucket.tokens + elapsed * env.RATE_LIMIT_RPS);
    bucket.lastRefill = now;
    if (bucket.tokens < 1) {
      res.status(429).set("Retry-After", "1").json({ error: "rate_limited" });
      return;
    }
    bucket.tokens -= 1;
    next();
  });
  setInterval(() => {
    const cutoff = Date.now() - 5 * 60_000;
    for (const [ip, _] of rateBuckets) {
      if (rateBuckets.get(ip).lastRefill < cutoff) rateBuckets.delete(ip);
    }
  }, 5 * 60_000).unref();

  // ===== IP allowlist (env.MCP_ALLOWED_IPS / env.ALLOWED_IPS) =====
  // When set, drops requests whose socket remote address doesn't match any
  // entry. Entries may be:
  //   "1.2.3.4"             — exact IP
  //   "1.2.3.4:3101"        — exact IP:port (both must match)
  //   "10.0.0.0/8"          — CIDR (IPv4 only for now; IPv6 /nn supported)
  // Comparison handles IPv4-mapped IPv6 (::ffff:1.2.3.4).
  function ipToBigInt(ip) {
    // Returns a number for IPv4, bigint for IPv6. /0 catch-all returns null.
    if (ip.includes(":")) {
      // IPv6
      if (ip === "::" || ip === "0:0:0:0:0:0:0:0") return 0n;
      const parts = ip.split("::");
      const head = (parts[0] || "").split(":").filter(Boolean);
      const tail = (parts[1] || "").split(":").filter(Boolean);
      const fill = 8 - head.length - tail.length;
      if (fill < 0) return null;
      const full = [...head, ...Array(fill).fill("0"), ...tail];
      const normalized = full.map(p => p.padStart(4, "0")).join("");
      try { return BigInt("0x" + normalized); } catch { return null; }
    }
    // IPv4
    const octets = ip.split(".");
    if (octets.length !== 4) return null;
    let v = 0n;
    for (const o of octets) {
      const n = Number(o);
      if (!Number.isInteger(n) || n < 0 || n > 255) return null;
      v = (v << 8n) | BigInt(n);
    }
    return v;
  }
  function ipv4MappedToV4(ip) {
    // ::ffff:1.2.3.4 -> 1.2.3.4
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    return m ? m[1] : ip;
  }
  const allowedIpRules = env.ALLOWED_IPS.map(entry => {
    let cidr = null;
    let port = null;
    let bare = null;
    if (entry.includes("/")) {
      const [base, prefixStr] = entry.split("/");
      const prefix = Number(prefixStr);
      if (!Number.isInteger(prefix)) return null;
      const ipNum = ipToBigInt(ipv4MappedToV4(base));
      if (ipNum === null) return null;
      const isV6 = base.includes(":");
      const maxBits = isV6 ? 128 : 32;
      if (prefix < 0 || prefix > maxBits) return null;
      const mask = ((1n << BigInt(maxBits - prefix)) - 1n) ^ ((1n << BigInt(maxBits)) - 1n);
      cidr = { ipNum, mask, isV6 };
    } else if (entry.includes(":")) {
      // Could be IP:port (IPv4) or bare IPv6
      const lastColon = entry.lastIndexOf(":");
      const maybePort = Number(entry.slice(lastColon + 1));
      if (Number.isInteger(maybePort) && maybePort >= 0 && maybePort <= 65535
          && !entry.slice(0, lastColon).includes(":")) {
        // IPv4:port
        const ipNum = ipToBigInt(entry.slice(0, lastColon));
        if (ipNum === null) return null;
        bare = { ipNum, port: maybePort };
      } else {
        // Bare IPv6
        const ipNum = ipToBigInt(entry);
        if (ipNum === null) return null;
        bare = { ipNum, port: null };
      }
    } else {
      // Bare IPv4 (possibly with :port)
      const lastColon = entry.lastIndexOf(":");
      if (lastColon >= 0) {
        const maybePort = Number(entry.slice(lastColon + 1));
        if (Number.isInteger(maybePort) && maybePort >= 0 && maybePort <= 65535) {
          const ipNum = ipToBigInt(entry.slice(0, lastColon));
          if (ipNum === null) return null;
          bare = { ipNum, port: maybePort };
          return bare;
        }
      }
      const ipNum = ipToBigInt(entry);
      if (ipNum === null) return null;
      bare = { ipNum, port: null };
    }
    return cidr || bare;
  }).filter(Boolean);

  if (allowedIpRules.length > 0) {
    app.use((req, res, next) => {
      const remote = req.ip || req.socket.remoteAddress || "";
      const clientIp = ipv4MappedToV4(remote);
      const clientPort = req.socket.remotePort;
      const clientNum = ipToBigInt(clientIp);
      const matched = allowedIpRules.some(rule => {
        if (rule.mask !== undefined) {
          // CIDR
          const sameFamily = (rule.isV6 && clientIp.includes(":"))
            || (!rule.isV6 && !clientIp.includes(":"));
          if (!sameFamily) return false;
          return clientNum !== null && (clientNum & rule.mask) === rule.ipNum;
        }
        // Bare / IP:port
        if (clientNum === null || clientNum !== rule.ipNum) return false;
        if (rule.port !== null && rule.port !== clientPort) return false;
        return true;
      });
      if (!matched) {
        res.status(403).json({ error: "ip_not_allowed" });
        return;
      }
      next();
    });
  }

  // ----- 5.3 Routes -----
  // /health: minimal info for LB probes. toolNames are *internal* structure
  // (subcommand lists, namespaced tool ids) — exposing them unauthenticated is
  // a side-channel leak. Opt in with HEALTH_EXPOSE_DETAILS=1 if you really
  // need them (e.g. dev/debug). Same for cliResolved — could disclose which
  // CLI the gateway is wrapping to a probing attacker.
  const healthBody = {
    ok: true,
    authMode: env.AUTH_MODE,
    uptimeSec: Math.floor(process.uptime()),
  };
  if (process.env.HEALTH_EXPOSE_DETAILS === "1") {
    healthBody.toolNames = [...allowedTools];
    healthBody.cliResolved = Boolean(env.CLI_COMMAND);
  }
  app.get(healthPath, (_req, res) => res.json(healthBody));

  if (oauthNeeded) {
    app.get("/.well-known/oauth-protected-resource", (_req, res) => res.json({
      resource: `${env.PUBLIC_ENDPOINT}/mcp`,
      authorization_servers: [env.AUTH0_ISSUER || env.OAUTH_ISSUER],
      bearer_methods_supported: ["header"],
      scopes_supported: env.AUTH0_ISSUER ? [env.AUTH0_REQ_SCOPE, "offline_access"] : ["tools:read", "tools:write"],
    }));

    const authorizationMetadata = (_req, res) => res.json({
      issuer: env.AUTH0_ISSUER ? `${env.AUTH0_ISSUER}/` : env.OAUTH_ISSUER,
      authorization_endpoint: `${env.AUTH0_ISSUER || env.OAUTH_ISSUER}/authorize`,
      token_endpoint: `${env.AUTH0_ISSUER || env.OAUTH_ISSUER}/oauth/token`,
      ...(env.AUTH0_ISSUER
        ? { registration_endpoint: `${env.AUTH0_ISSUER}/oidc/register` }
        : { registration_endpoint: `${env.OAUTH_ISSUER}/oauth/register` }),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: env.AUTH0_ISSUER
        ? [env.AUTH0_REQ_SCOPE, "offline_access"]
        : ["tools:read", "tools:write", "offline_access"],
    });
    app.get("/.well-known/oauth-authorization-server", authorizationMetadata);
    app.get("/.well-known/openid-configuration", authorizationMetadata);

    app.post("/oauth/register", (req, res) => {
      const { redirect_uris: redirectUris, client_name: clientName = "MCP client" } = req.body || {};
      if (!validRedirectUris(redirectUris)) return res.status(400).json({ error: "invalid_redirect_uri" });
      const clientId = `client_${randomBytes(18).toString("base64url")}`;
      oauthClients.set(clientId, { clientName, redirectUris });
      res.status(201).json({
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: clientName,
        redirect_uris: redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
    });

    app.get("/oauth/authorize", (req, res) => {
      const { client_id: clientId, redirect_uri: redirectUri, response_type: responseType, code_challenge: codeChallenge, code_challenge_method: codeChallengeMethod = "S256", state = "", scope = "tools:read tools:write" } = req.query;
      const client = oauthClients.get(clientId);
      console.log(`OAuth authorize request: client=${clientId || "missing"} redirect=${redirectUri || "missing"}`);
      if (!client || responseType !== "code" || codeChallengeMethod !== "S256" || !client.redirectUris.includes(redirectUri)) {
        return res.status(400).send("Invalid OAuth authorization request");
      }
      const hidden = { client_id: clientId, redirect_uri: redirectUri, code_challenge: codeChallenge, code_challenge_method: codeChallengeMethod, state, scope };
      const escapeHtml = v => String(v).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      const hiddenInputs = Object.entries(hidden).map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}" />`).join("");
      res.type("html").send(`<!doctype html><title>Authorize MCP App</title><h1>Authorize ${escapeHtml(client.clientName)}</h1><form method="post">${hiddenInputs}<label>Username <input name="username" autocomplete="username" /></label><br><label>Password <input name="password" type="password" autocomplete="current-password" /></label><br><button>Authorize</button></form>`);
    });

    app.post("/oauth/authorize", (req, res) => {
      const { client_id: clientId, redirect_uri: redirectUri, code_challenge: codeChallenge, code_challenge_method: codeChallengeMethod, state = "", scope = "tools:read tools:write", username, password } = req.body || {};
      const client = oauthClients.get(clientId);
      if (!client || codeChallengeMethod !== "S256" || !client.redirectUris.includes(redirectUri)) return res.status(400).send("Invalid OAuth authorization request");
      if (!safeEqual(String(username || ""), env.OAUTH_USERNAME) || !safeEqual(String(password || ""), env.OAUTH_PASSWORD)) return res.status(401).send("Invalid username or password");
      const code = randomBytes(32).toString("base64url");
      const grantedScope = [...new Set(`${scope} offline_access`.trim().split(/\s+/))].join(" ");
      authorizationCodes.set(code, { clientId, redirectUri, codeChallenge, scope: grantedScope, expiresAt: Date.now() + 300_000 });
      const redirect = new URL(redirectUri);
      redirect.searchParams.set("code", code);
      if (state) redirect.searchParams.set("state", state);
      console.log(`OAuth authorize success: client=${clientId} redirect=${redirectUri}`);
      res.redirect(redirect.toString());
    });

    app.post("/oauth/token", (req, res) => {
      const { grant_type: grantType, code, client_id: clientId, redirect_uri: redirectUri, code_verifier: codeVerifier, refresh_token: refreshToken } = req.body || {};
      if (grantType === "refresh_token" && refreshToken && oauthTokens.has(refreshToken)) {
        const old = oauthTokens.get(refreshToken);
        oauthTokens.delete(refreshToken);
        const accessToken = issueAccessToken(old.clientId, old.scope);
        return res.json({ access_token: accessToken, token_type: "Bearer", expires_in: 3600, scope: old.scope });
      }
      const record = authorizationCodes.get(code);
      if (grantType !== "authorization_code" || !record || record.expiresAt < Date.now() || record.clientId !== clientId || record.redirectUri !== redirectUri || !codeVerifier || hashVerifier(codeVerifier) !== record.codeChallenge) {
        return res.status(400).json({ error: "invalid_grant" });
      }
      authorizationCodes.delete(code);
      const accessToken = issueAccessToken(clientId, record.scope);
      const newRefreshToken = randomBytes(32).toString("base64url");
      oauthTokens.set(newRefreshToken, { clientId, scope: record.scope, expiresAt: Date.now() + 30 * 86400_000 });
      res.json({ access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: newRefreshToken, scope: record.scope });
    });
  }

  // ----- 5.4 /mcp endpoint -----
  const transports = new Map();
  app.all("/mcp", async (req, res) => {
    if (!(await authorized(req, res))) return;
    const sessionId = req.headers["mcp-session-id"];
    let transport = sessionId ? transports.get(sessionId) : undefined;

    try {
      if (!transport && req.method === "POST" && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => transports.set(id, transport),
        });
        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
        };
        await createServer().connect(transport);
      }

      if (!transport) {
        res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Missing or invalid MCP session" }, id: null });
        return;
      }
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request error:", error);
      if (!res.headersSent) res.status(500).json({ error: "internal server error" });
    }
  });

  // ----- 5.5 启动 + 完整 graceful shutdown -----
  const httpServer = app.listen(env.PORT, env.HOST, () => {
    console.log(`cli2mcp-gateway (http) listening on http://${env.HOST}:${env.PORT}/mcp`);
    console.log(`allowlisted tools: ${[...allowedTools].join(", ")}`);
    console.log(`auth mode: ${env.AUTH_MODE}`);
    console.log(`cors origins: ${env.CORS_ORIGINS.length ? env.CORS_ORIGINS.join(", ") : "(none — browser clients blocked)"}`);
    console.log(`rate limit: ${env.RATE_LIMIT_RPS} rps / burst ${env.RATE_LIMIT_BURST}`);
    if (["bearer", "both"].includes(env.AUTH_MODE)) {
      console.log(`bearer token: ${env.TOKEN}`);
    }
    if (oauthNeeded) console.log(`oauth issuer: ${env.OAUTH_ISSUER}`);
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] received ${signal} — draining (max 10s)`);
    // 1) 停接新连接
    httpServer.close((err) => {
      if (err) console.error(`[shutdown] httpServer.close error: ${err.message}`);
      else console.log("[shutdown] http server closed");
    });
    // 2) 关所有 MCP transport(等活跃 stream 写完)
    const transportClosePromises = [...transports.values()].map(t => t.close().catch(() => {}));
    // 3) 兜底:10 秒强制退出
    const forceExit = setTimeout(() => {
      console.error("[shutdown] timeout — forcing exit");
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    await Promise.allSettled(transportClosePromises);
    clearTimeout(forceExit);
    console.log("[shutdown] clean exit");
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    console.error("[uncaughtException]", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", reason);
  });
}

// ===== 6. 入口分发 =====
if (wantHttp) {
  await runHttp();
} else {
  await runStdio();
}
