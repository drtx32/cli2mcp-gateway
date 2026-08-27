// Hermés task-identity env keys. When the gateway runs as a long-lived
// daemon child (e.g. PM2 inside a hermes task), `process.env` carries
// these from the parent. Forwarding them to a downstream CLI causes
// that CLI to take its "agent execution context" code path (which
// requires a task-scoped mat_ token), and the multica server then
// rejects with "Task token rejected" because the gateway is not
// itself the originating task runtime.
//
// We strip ALL of them so the CLI falls back to its "host or user
// profile" code path — reading /root/.multica/config.json for the
// user PAT and talking to api.multica.ai directly. This is the
// same path `multica login` would produce.
export const TASK_SCOPED_KEYS = Object.freeze([
  // Task identity (forces "agent execution context" code path)
  "MULTICA_TOKEN",
  "MULTICA_TASK_ID",
  "MULTICA_TASK_SLOT",
  "MULTICA_AGENT_ID",
  "MULTICA_AGENT_NAME",
  "MULTICA_WORKSPACE_ID",
  "MULTICA_TASK_CONFIG_ROOT",
  "MULTICA_TASK_WORKSPACES_ROOT",
  "MULTICA_DAEMON_ID",
  // Daemon-injected transport (also forces agent-execution-context path:
  // "MULTICA_DAEMON_PORT is set without task identity")
  "MULTICA_DAEMON_PORT",
  "MULTICA_SERVER_URL",
  // Misc hermes runtime knobs that pollute the CLI's view of the caller
  "MULTICA_LAUNCHED_BY",
  "MULTICA_AGENT_TEMP_BASE",
  "MULTICA_QUICK_CREATE_ATTACHMENT_IDS",
  "MULTICA_CODEX_PATH",
  "MULTICA_CODEX_ARGS",
  "MULTICA_CODEX_HANDSHAKE_TIMEOUT",
  "MULTICA_CODEX_MULTI_AGENT",
  "MULTICA_DAEMON_AUTO_UPDATE_INTERVAL",
  "MULTICA_DAEMON_AUTO_RELOAD",
  "MULTICA_DAEMON_HEARTBEAT_INTERVAL",
  "MULTICA_DAEMON_LOG_MAX_AGE_DAYS",
  "MULTICA_DAEMON_MAX_CONCURRENT_TASKS",
  "MULTICA_GC_ENABLED",
  "MULTICA_GROK_MODEL",
  "MULTICA_KIMI_MODEL",
  "MULTICA_KIRO_MODEL",
  "MULTICA_QODER_PATH",
  "MULTICA_QWEN_MODEL",
  "MULTICA_MCODE_PATH",
]);

export function buildServiceEnv(parentEnv, svcEnv = {}) {
  const clean = { ...parentEnv };
  for (const k of TASK_SCOPED_KEYS) delete clean[k];
  return { ...clean, ...svcEnv };
}
