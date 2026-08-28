// box-config.mjs — multi-service box config loader
//
// Reads a YAML config file, expands ${VAR} references, applies env_file
// overlays (docker-compose semantics), validates with zod, and returns a
// normalized runtime structure.
//
// CLI usage:
//   cli2mcp-gateway serve --config /etc/cli2mcp-gateway/box.yaml [--env-dir DIR]
//
// Backward compatible: if --config is omitted, call into legacyEnvConfig()
// to derive a single-service box from the existing env vars.

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { z } from "zod";
import YAML from "yaml";

const ENV_VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g;

// ---------- env_file loader (dotenv-style: KEY=VALUE, comments with #, blanks OK)
function loadEnvFile(path) {
  if (!existsSync(path)) {
    return { ok: false, missing: true, path };
  }
  const text = readFileSync(path, "utf8");
  const env = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // Strip optional `export ` prefix.
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let [, key, raw] = m;
    // Strip surrounding quotes.
    if ((raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))) {
      raw = raw.slice(1, -1);
    }
    env[key] = raw;
  }
  return { ok: true, missing: false, path, env };
}

// Expand ${VAR} / ${VAR:-default} in any string value.
function expandString(input, ctx) {
  if (typeof input !== "string") return input;
  return input.replace(ENV_VAR_RE, (_, name, dflt) => {
    if (Object.prototype.hasOwnProperty.call(ctx, name)) return ctx[name];
    if (dflt !== undefined) return dflt;
    throw new Error(`box-config: unresolved variable \${${name}}`);
  });
}

function expandDeep(value, ctx) {
  if (Array.isArray(value)) return value.map(v => expandDeep(v, ctx));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandDeep(v, ctx);
    return out;
  }
  return expandString(value, ctx);
}

// Resolve an env_file entry into a flat {KEY: VALUE} map.
// Supports both shorthand strings and {path, required, format} objects.
function resolveEnvFiles(entries, basePath) {
  const files = Array.isArray(entries) ? entries : (entries ? [entries] : []);
  const out = {};
  for (const entry of files) {
    const spec = (typeof entry === "string")
      ? { path: entry, required: false, format: "dotenv" }
      : entry;
    const abs = isAbsolute(spec.path) ? spec.path : resolve(basePath, spec.path);
    const result = loadEnvFile(abs);
    if (!result.ok) {
      if (spec.required) {
        throw new Error(`box-config: required env_file not found: ${abs}`);
      }
      continue;
    }
    Object.assign(out, result.env);
  }
  return out;
}

// ---------- zod schema for box.yaml ----------

// env_file entry: shorthand string OR {path, required, format}
const EnvFileEntry = z.union([
  z.string(),
  z.object({
    path: z.string(),
    required: z.boolean().optional().default(false),
    format: z.enum(["dotenv", "yaml"]).optional().default("dotenv"),
  }),
]);

const TransportSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    inherit_process_env: z.boolean().optional().default(true),
  }),
  z.object({
    type: z.literal("http"),
    host: z.string().optional().default("127.0.0.1"),
    port: z.number().int().min(1).max(65535),
    path: z.string().optional().default("/mcp"),
  }),
  z.object({
    type: z.literal("sse"),
    host: z.string().optional().default("127.0.0.1"),
    port: z.number().int().min(1).max(65535),
  }),
]);

const ServiceBase = z.object({
  env_file: z.union([EnvFileEntry, z.array(EnvFileEntry)]).optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeout_ms: z.number().int().optional().default(60_000),
  max_output_bytes: z.number().int().optional().default(16_000),
});

const ServiceSchema = z.discriminatedUnion("adapter", [
  // ---- auto adapter ----
  // Probe a command as MCP stdio first, including a conventional `mcp`
  // subcommand, and fall back to the help-driven CLI adapter.
  ServiceBase.extend({
    adapter: z.literal("auto"),
    command: z.string(),
    args: z.array(z.string()).optional().default([]),
    cwd: z.string().optional(),
    subcommands: z.array(z.string()).optional(),
    dual_tool_mode: z.boolean().optional().default(false),
    skip_recursive: z.boolean().optional().default(false),
  }),
  // ---- cli adapter (current capability) ----
  ServiceBase.extend({
    adapter: z.literal("cli"),
    command: z.string(),
    args: z.array(z.string()).optional().default([]),
    cwd: z.string().optional(),
    subcommands: z.array(z.string()).optional(),
    // When true, skip recursive <cli> <sub> --help discovery and instead
    // emit two synthetic tools (`<cli>_help` and `<cli>_run`). Useful when
    // the CLI's --help output doesn't yield per-subcommand schemas (e.g.
    // typer/rich panels that group commands). The <cli>_run tool forwards
    // any subcommand path + args verbatim at call time.
    dual_tool_mode: z.boolean().optional().default(false),
    // When true, only run --help on the top level + each top-level
    // subcommand; skip the deeper sub-subcommand walk. Faster boot, fewer
    // tools. Each exposed tool still accepts the deeper subcommand as an
    // `args` array.
    skip_recursive: z.boolean().optional().default(false),
  }),
  // ---- mcp-stdio adapter (deferred to Phase 5, but schema valid now) ----
  ServiceBase.extend({
    adapter: z.literal("mcp-stdio"),
    command: z.string(),
    args: z.array(z.string()).optional().default([]),
    cwd: z.string().optional(),
  }),
  // ---- mcp-http adapter ----
  ServiceBase.extend({
    adapter: z.literal("mcp-http"),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional().default({}),
    auth: z.object({
      type: z.enum(["headers", "bearer", "oauth"]).optional().default("headers"),
      token: z.string().optional(),
    }).optional().default({}),
  }),
  // ---- openapi adapter (Phase 5) ----
  ServiceBase.extend({
    adapter: z.literal("openapi"),
    spec: z.string(),
    base_url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional().default({}),
  }),
  // ---- graphql adapter (Phase 5) ----
  ServiceBase.extend({
    adapter: z.literal("graphql"),
    endpoint: z.string().url(),
    headers: z.record(z.string(), z.string()).optional().default({}),
  }),
]);

const NamingSchema = z.object({
  separator: z.string().optional().default("__"),
  prefix: z.string().optional().default(""),
  collision_policy: z.enum(["prefix_upstream", "suffix_upstream", "error"]).optional()
    .default("prefix_upstream"),
}).optional().default({});

const BoxSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),

  services: z.record(z.string().regex(/^[a-z][a-z0-9_-]*$/), ServiceSchema)
    .refine(svc => Object.keys(svc).length >= 1, { message: "at least one service required" }),

  naming: NamingSchema,

  transport: TransportSchema,

  auth: z.object({
    mode: z.enum(["bearer", "oauth", "auth0", "none"]).default("bearer"),
    token: z.string().optional(),                  // inline (dev)
    env_file: z.union([EnvFileEntry, z.array(EnvFileEntry)]).optional(),
    env_var: z.string().optional().default("MCP_TOKEN"),
  }).optional().default({}),

  cors: z.object({
    enabled: z.boolean().optional().default(false),
    origins: z.array(z.string()).optional().default([]),
  }).optional().default({}),

  rate_limit: z.object({
    rps: z.number().optional().default(20),
    burst: z.number().optional().default(40),
  }).optional().default({}),

  ip_allowlist: z.array(z.string()).optional().default([]),

  filters: z.object({
    request_headers: z.object({
      add: z.record(z.string(), z.string()).optional().default({}),
      remove: z.array(z.string()).optional().default([]),
    }).optional().default({}),
  }).optional().default({}),

  health: z.object({
    path: z.string().optional().default("/health"),
    expose_details: z.boolean().optional().default(false),
  }).optional().default({}),

  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).optional().default("info"),
    format: z.enum(["json", "text"]).optional().default("text"),
    output: z.string().optional(),
    request_log: z.boolean().optional().default(false),
  }).optional().default({}),

  replicas: z.number().int().min(1).optional().default(1),
  restart: z.string().optional(),
});

// ---------- legacy: synthesize a single-service box from old env vars ----------
// Lets you do `cli2mcp-gateway serve --http` without a yaml and still get the
// legacy behaviour that everyone was running until now.
export function legacyEnvConfig() {
  const base = {
    HOST: process.env.HOST || "127.0.0.1",
    PORT: Number(process.env.PORT || 3100),
    AUTH_MODE: process.env.AUTH_MODE || "bearer",
    MCP_TOKEN: process.env.MCP_TOKEN || "",
    CLI_COMMAND: process.env.CLI_COMMAND || process.env.CLI2MCP_COMMAND || "rg",
    CLI_CWD: process.env.CLI_CWD || process.env.CLI2MCP_CWD || process.cwd(),
    CLI_TIMEOUT_MS: Number(process.env.CLI_TIMEOUT_MS || 60_000),
    CLI_MAX_OUTPUT_BYTES: Number(process.env.CLI_MAX_OUTPUT_BYTES || 16_000),
    RATE_LIMIT_RPS: Number(process.env.RATE_LIMIT_RPS || 20),
    RATE_LIMIT_BURST: Number(process.env.RATE_LIMIT_BURST || 40),
    CORS_ORIGINS: (process.env.CORS_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean),
    ALLOWED_HOSTS: (process.env.ALLOWED_HOSTS || "").split(",").map(s => s.trim()).filter(Boolean),
    CLI_SUBCOMMANDS: (process.env.CLI_SUBCOMMANDS || process.env.CLI2MCP_SUBCOMMANDS || "")
      .split(",").map(s => s.trim()).filter(Boolean),
    CLI_DUAL_TOOL_MODE: ["1","true","yes"].includes(
      String(process.env.CLI_DUAL_TOOL_MODE || "").toLowerCase()),
  };
  const svcName = (base.CLI_COMMAND || "cli").replace(/[^a-z0-9_-]/gi, "_").toLowerCase();

  // Expand CORS_ORIGINS / ALLOWED_HOSTS / CLI_SUBCOMMANDS, since the legacy
  // pipeline split-then-passed them as arrays; we serialise back into yaml.
  return {
    name: `legacy-${svcName}`,
    version: undefined,
    services: {
      [svcName]: {
        adapter: "cli",
        command: base.CLI_COMMAND,
        args: [],
        cwd: base.CLI_CWD || undefined,
        subcommands: base.CLI_SUBCOMMANDS.length ? base.CLI_SUBCOMMANDS : undefined,
        env: undefined,
        env_file: undefined,
        timeout_ms: base.CLI_TIMEOUT_MS,
        max_output_bytes: base.CLI_MAX_OUTPUT_BYTES,
        __legacy: {
          CLI_DUAL_TOOL_MODE: base.CLI_DUAL_TOOL_MODE,
        },
      },
    },
    naming: {},
    transport: { type: "http", host: base.HOST, port: base.PORT, path: "/mcp" },
    auth: {
      mode: base.AUTH_MODE === "oauth" || base.AUTH_MODE === "auth0" ? base.AUTH_MODE : (base.MCP_TOKEN ? "bearer" : "none"),
      token: base.MCP_TOKEN || undefined,
      env_file: undefined,
      env_var: "MCP_TOKEN",
    },
    cors: { enabled: base.CORS_ORIGINS.length > 0, origins: base.CORS_ORIGINS },
    rate_limit: { rps: base.RATE_LIMIT_RPS, burst: base.RATE_LIMIT_BURST },
    ip_allowlist: base.ALLOWED_HOSTS, // legacy used ALLOWED_HOSTS for both; we map ip_allowlist only on legacy, see expandDeep
    filters: { request_headers: { add: {}, remove: [] } },
    health: { path: "/health", expose_details: false },
    logging: { level: "info", format: "text", output: undefined, request_log: false },
    replicas: 1,
    restart: undefined,
    __legacy: true,
  };
}

// ---------- main entry: load and validate box.yaml ----------
export function loadBoxConfig(configPath, opts = {}) {
  const basePath = opts.envDir
    ? resolve(opts.envDir)
    : dirname(resolve(configPath));

  // 1. Read YAML.
  const rawText = readFileSync(configPath, "utf8");
  const parsed = YAML.parse(rawText);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`box-config: ${configPath} did not parse to an object`);
  }

  // 2. Expand ${VAR} using current process env. This must happen BEFORE
  // env_file overlays, so that an env_file path can itself contain a ${VAR}.
  const expandCtx = { ...process.env };
  const expanded = expandDeep(parsed, expandCtx);

  // 3. Resolve env_file at every level (service, auth, transport).
  // We do this *before* schema validation so the merged env can be applied
  // to defaults inside the schema (e.g. auth.token from env_file).
  for (const [name, svc] of Object.entries(expanded.services ?? {})) {
    const merged = resolveEnvFiles(svc.env_file, basePath);
    svc.env = { ...merged, ...(svc.env || {}) };
  }
  if (expanded.auth?.env_file) {
    const merged = resolveEnvFiles(expanded.auth.env_file, basePath);
    // env_var is the key inside merged that holds the token. Defaults to MCP_TOKEN.
    const varName = expanded.auth.env_var || "MCP_TOKEN";
    expanded.auth.token = expanded.auth.token || merged[varName];
    // If still missing and mode=bearer, defer to existing process env.
    if (!expanded.auth.token && expanded.auth.mode === "bearer" && process.env[varName]) {
      expanded.auth.token = process.env[varName];
    }
  }

  // 4. Validate via zod.
  const result = BoxSchema.safeParse(expanded);
  if (!result.success) {
    const issues = result.error.issues.map(i =>
      `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`box-config: ${configPath} failed validation:\n${issues}`);
  }

  // 5. Map CLI_DUAL_TOOL_MODE legacy flag onto the cli service.
  for (const svc of Object.values(result.data.services)) {
    if (svc.adapter === "cli" && process.env.CLI_DUAL_TOOL_MODE) {
      svc.__legacy = svc.__legacy || {};
      svc.__legacy.CLI_DUAL_TOOL_MODE =
        ["1","true","yes"].includes(String(process.env.CLI_DUAL_TOOL_MODE).toLowerCase());
    }
  }

  return { path: configPath, config: result.data };
}

// ---------- CLI subcommands for inspection ----------
export function configSummary(box) {
  const c = box.config;
  const lines = [
    `name:        ${c.name}`,
    `transport:   ${c.transport.type}${c.transport.type !== "stdio" ? ` on ${c.transport.host ?? "127.0.0.1"}:${c.transport.port}` : ""}`,
    `auth:        ${c.auth?.mode ?? "bearer"}`,
    `services:    ${Object.keys(c.services).length}`,
  ];
  for (const [name, svc] of Object.entries(c.services)) {
    let detail = svc.adapter;
    if (svc.adapter === "cli") detail += ` (${svc.command})`;
    if (svc.adapter === "mcp-http") detail += ` (${svc.url})`;
    if (svc.adapter === "openapi") detail += ` (${svc.base_url})`;
    lines.push(`  - ${name}: ${detail}`);
  }
  return lines.join("\n");
}
