// ELI-467 regression — tools/list must not advertise capabilities the gateway
// does not implement (review finding PRRT_kwDOTuKzQs6vjNab, P2).
//
// The metadata passthrough added in this branch forwards the upstream's
// `execution` field, which carries `taskSupport`:
//
//   "required" -> clients MUST invoke the tool as a task
//   "optional" -> clients MAY invoke the tool as a task
//   "forbidden"-> clients MUST NOT invoke the tool as a task
//
// This gateway implements no part of task-augmented execution. It advertises
// `capabilities: { tools: {} }` (no `tasks`), its tools/call handler destructures
// only `{ name, arguments }` so `params.task` is dropped on the floor, and it
// registers no `tasks/*` handlers for the client to poll a result through.
//
// Forwarding the declaration anyway is therefore a protocol-truthfulness bug
// with a concrete failure mode: the official MCP SDK client reads
// `tools/list`, caches `execution.taskSupport === "required"`, and then
// `callTool()` throws *locally, without sending a request at all*. The tool
// becomes permanently uncallable through this gateway.
//
// These tests pin the rule: `execution` is NOT forwardable; the safe,
// non-capability metadata still is.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { FIXTURE_B, startGateway, startHttpUpstream, withSession } from "./_aggregate-helpers.mjs";
import { pickUpstreamToolMeta, UPSTREAM_TOOL_META_FIELDS } from "../src/tool-aggregator.mjs";

const GATEWAY_PORT = 31575;
const TOKEN = "eli467-dummy-token";
const DOWNSTREAM = { token: TOKEN };

// ToolSchema spreads `...IconsSchema.shape`, so a Tool's `icons` is a bare
// Icon[] — not `{ icons: [...] }`. The strict SDK-client test below is what
// caught that distinction.
const ICONS = [{ src: "data:image/png;base64,iVBORw0KGgo=", mimeType: "image/png", sizes: ["48x48"] }];

const ALPHA_TOOLS = [
  {
    name: "task_required",
    title: "Task Required",
    description: "Upstream demands task-augmented execution.",
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    execution: { taskSupport: "required" },
    annotations: { readOnlyHint: true },
    icons: ICONS,
    _meta: { "upstream-origin": "alpha" },
  },
  {
    name: "task_optional",
    description: "Upstream accepts either form.",
    inputSchema: { type: "object", properties: {} },
    execution: { taskSupport: "optional" },
  },
  {
    name: "task_forbidden",
    description: "Upstream explicitly forbids tasks.",
    inputSchema: { type: "object", properties: {} },
    execution: { taskSupport: "forbidden" },
  },
  {
    name: "plain",
    title: "Plain",
    description: "No execution field at all.",
    inputSchema: { type: "object", properties: { limit: { type: "integer" } } },
    annotations: { readOnlyHint: true, idempotentHint: true },
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
    icons: ICONS,
    _meta: { "upstream-origin": "alpha", tier: "free" },
  },
];

function writeBox(boxPath, alphaUrl) {
  writeFileSync(boxPath, [
    "name: eli467-task-truthfulness",
    "services:",
    "  alpha:",
    "    adapter: mcp-http",
    `    url: ${alphaUrl}`,
    "    timeout_ms: 8000",
    "  beta:",
    "    adapter: mcp-stdio",
    `    command: ${process.execPath}`,
    "    args:",
    `      - ${FIXTURE_B}`,
    "    timeout_ms: 8000",
    "transport:",
    "  type: http",
    "  host: 127.0.0.1",
    `  port: ${GATEWAY_PORT}`,
    "  path: /mcp",
    "auth:",
    "  mode: bearer",
    `  token: ${TOKEN}`,
    "naming:",
    "  separator: __",
    "",
  ].join("\n"), "utf8");
}

// ---------- unit: the allowlist itself ----------

test("task support: `execution` is not in the forwardable allowlist", () => {
  assert.ok(!UPSTREAM_TOOL_META_FIELDS.includes("execution"),
    "execution must never be forwarded — it declares a capability we do not implement");
});

test("task support: pickUpstreamToolMeta strips execution at every taskSupport value", () => {
  for (const taskSupport of ["required", "optional", "forbidden"]) {
    assert.deepEqual(
      pickUpstreamToolMeta({ name: "t", execution: { taskSupport } }),
      {},
      `execution.taskSupport=${taskSupport} leaked through`,
    );
    // ...while the genuinely safe siblings on the same tool still survive.
    assert.deepEqual(
      pickUpstreamToolMeta({ execution: { taskSupport }, title: "T", annotations: { readOnlyHint: true } }),
      { title: "T", annotations: { readOnlyHint: true } },
    );
  }
});

test("task support: the remaining allowlist carries no capability negotiation", () => {
  // Everything still forwarded must be pure description / hint data. Any field
  // that changes how a client *invokes* the tool has to stay out.
  assert.deepEqual(UPSTREAM_TOOL_META_FIELDS.slice().sort(),
    ["_meta", "annotations", "icons", "outputSchema", "title"]);
});

// ---------- e2e: what a real client sees ----------

test("task support: downstream tools/list never advertises execution", async () => {
  const alpha = await startHttpUpstream({ tools: ALPHA_TOOLS, label: "alpha" });
  const workdir = mkdtempSync(resolve(tmpdir(), "cli2mcp-eli467-task-"));
  const boxPath = resolve(workdir, "box.yaml");
  writeBox(boxPath, alpha.url);
  const gw = await startGateway({ boxPath, port: GATEWAY_PORT });

  try {
    await gw.waitReady();
    const listed = await withSession(GATEWAY_PORT, DOWNSTREAM, async (mcp) =>
      (await mcp.listTools()).tools);

    // The three task-declaring tools must reach downstream WITHOUT execution.
    for (const name of ["alpha__task_required", "alpha__task_optional", "alpha__task_forbidden"]) {
      const tool = listed.find((t) => t.name === name);
      assert.ok(tool, `${name} missing from the catalog`);
      assert.equal(tool.execution, undefined,
        `${name} advertises execution=${JSON.stringify(tool.execution)} but this gateway ` +
        `declares no tasks capability, drops params.task, and proxies no task lifecycle`);
    }
    // Nothing in the catalog declares it.
    assert.deepEqual(listed.filter((t) => t.execution !== undefined).map((t) => t.name), []);
  } finally {
    await gw.stop();
    rmSync(workdir, { recursive: true, force: true });
    await alpha.close();
  }
});

test("task support: safe metadata on the same tools is still forwarded", async () => {
  const alpha = await startHttpUpstream({ tools: ALPHA_TOOLS, label: "alpha" });
  const workdir = mkdtempSync(resolve(tmpdir(), "cli2mcp-eli467-task-safe-"));
  const boxPath = resolve(workdir, "box.yaml");
  writeBox(boxPath, alpha.url);
  const gw = await startGateway({ boxPath, port: GATEWAY_PORT });

  try {
    await gw.waitReady();
    const listed = await withSession(GATEWAY_PORT, DOWNSTREAM, async (mcp) =>
      (await mcp.listTools()).tools);
    const byName = new Map(listed.map((t) => [t.name, t]));

    // Stripping `execution` must not have cost us the rest of the tool contract.
    const required = byName.get("alpha__task_required");
    assert.equal(required.title, "Task Required");
    assert.deepEqual(required.annotations, { readOnlyHint: true });
    assert.deepEqual(required.icons, ICONS);
    assert.deepEqual(required._meta, { "upstream-origin": "alpha" });

    const plain = byName.get("alpha__plain");
    assert.equal(plain.title, "Plain");
    assert.deepEqual(plain.annotations, { readOnlyHint: true, idempotentHint: true });
    assert.deepEqual(plain.outputSchema, { type: "object", properties: { ok: { type: "boolean" } } });
    assert.deepEqual(plain.icons, ICONS);
    assert.deepEqual(plain._meta, { "upstream-origin": "alpha", tier: "free" });

    // Original name mapping and inputSchema are untouched by the fix.
    assert.deepEqual(required.inputSchema,
      { type: "object", properties: { q: { type: "string" } }, required: ["q"] });

    // Ordinary tools still route end to end.
    const plainCall = await withSession(GATEWAY_PORT, DOWNSTREAM, async (mcp) =>
      mcp.callTool("alpha__plain", { limit: 5 }));
    assert.equal(plainCall.result.content[0].text, "alpha:plain");
    assert.deepEqual(plainCall.result.structuredContent.received, { limit: 5 });

    // "optional" / "forbidden" upstreams are invocable normally and keep working.
    for (const name of ["alpha__task_optional", "alpha__task_forbidden"]) {
      const call = await withSession(GATEWAY_PORT, DOWNSTREAM, async (mcp) => mcp.callTool(name, {}));
      assert.equal(call.result.content[0].text, `alpha:${name.replace("alpha__", "")}`,
        `${name} should still be callable`);
    }
  } finally {
    await gw.stop();
    rmSync(workdir, { recursive: true, force: true });
    await alpha.close();
  }
});

test("task support: a task-required upstream fails loudly instead of being mis-advertised", async () => {
  // Documented limitation, pinned so it cannot regress silently: the gateway
  // does not implement task-augmented execution on the *upstream* hop either.
  // Its own MCP SDK client refuses a `taskSupport: required` tool locally, so
  // the call surfaces as an error to the caller.
  //
  // That is the honest outcome. Before this fix the same tool additionally
  // carried a task declaration downstream, which made every conformant client
  // refuse locally and never send the request at all — a strictly worse and
  // actively misleading failure. Supporting task-required upstreams end to end
  // (forward `params.task`, return CreateTaskResult, proxy tasks/result,
  // declare a `tasks` capability) is a feature, deliberately out of scope here.
  const alpha = await startHttpUpstream({ tools: ALPHA_TOOLS, label: "alpha" });
  const workdir = mkdtempSync(resolve(tmpdir(), "cli2mcp-eli467-task-required-"));
  const boxPath = resolve(workdir, "box.yaml");
  writeBox(boxPath, alpha.url);
  const gw = await startGateway({ boxPath, port: GATEWAY_PORT });

  try {
    await gw.waitReady();

    // Still advertised — the gateway does not hide a tool it cannot invoke.
    const listed = await withSession(GATEWAY_PORT, DOWNSTREAM, async (mcp) =>
      (await mcp.listTools()).tools);
    assert.ok(listed.some((t) => t.name === "alpha__task_required"));

    // ...but the call reports a real failure rather than a wrong success.
    const call = await withSession(GATEWAY_PORT, DOWNSTREAM, async (mcp) =>
      mcp.callTool("alpha__task_required", { q: "x" }, { timeoutMs: 20_000 }));
    const failed = Boolean(call.rpcError) || Boolean(call.transportError) || call.result?.isError === true;
    assert.ok(failed, `expected an honest failure, got ${JSON.stringify(call)}`);
  } finally {
    await gw.stop();
    rmSync(workdir, { recursive: true, force: true });
    await alpha.close();
  }
});

test("task support: the official SDK client can call the tools the gateway advertises", async () => {
  // The concrete failure the review predicted. The SDK client's callTool()
  // refuses task-required tools *locally*, before sending anything, so a
  // forwarded declaration does not merely mislead — it makes the tool
  // unreachable. With `execution` withheld, everything the gateway actually
  // advertises is callable.
  const alpha = await startHttpUpstream({ tools: ALPHA_TOOLS, label: "alpha" });
  const workdir = mkdtempSync(resolve(tmpdir(), "cli2mcp-eli467-sdk-"));
  const boxPath = resolve(workdir, "box.yaml");
  writeBox(boxPath, alpha.url);
  const gw = await startGateway({ boxPath, port: GATEWAY_PORT });

  const client = new McpClient({ name: "eli467-sdk-client", version: "1" }, { capabilities: {} });
  try {
    await gw.waitReady();

    // The gateway itself must not claim task capability, which is the reason
    // it cannot forward a taskSupport declaration.
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${GATEWAY_PORT}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } },
    );
    await client.connect(transport);

    assert.equal(client.getServerCapabilities()?.tasks, undefined,
      "gateway must not advertise a tasks capability it does not implement");

    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    assert.equal(byName.get("alpha__task_required").execution, undefined,
      "SDK client cached a taskSupport declaration the gateway cannot honour");
    // No tool in the whole catalog declares it.
    assert.deepEqual(tools.filter((t) => t.execution !== undefined).map((t) => t.name), []);

    // Everything the gateway advertises as ordinary is callable. This is the
    // call that used to throw "requires task-based execution" without ever
    // reaching the network.
    const plain = await client.callTool({ name: "alpha__plain", arguments: { limit: 1 } });
    assert.equal(plain.content[0].text, "alpha:plain");
    const optional = await client.callTool({ name: "alpha__task_optional", arguments: {} });
    assert.equal(optional.content[0].text, "alpha:task_optional");

    // The second upstream is unaffected.
    const fromBeta = await client.callTool({ name: "beta__ping", arguments: { seq: 1 } });
    assert.equal(fromBeta.content[0].text, "pong-from-beta seq=1");
  } finally {
    await client.close().catch(() => {});
    await gw.stop();
    rmSync(workdir, { recursive: true, force: true });
    await alpha.close();
  }
});