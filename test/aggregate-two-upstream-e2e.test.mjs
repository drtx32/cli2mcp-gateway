// ELI-467 acceptance — one box.yaml, two MCP upstreams, one downstream endpoint.
//
// Upstream A: mcp-http (in-process loopback stub, own session id).
// Upstream B: mcp-stdio (fixture script, spawned over stdio).
// Downstream: a single Streamable-HTTP MCP endpoint exposed by the gateway.
//
// Covers the issue's acceptance items 1 and 2:
//   1. one YAML / one endpoint / union of both catalogs, inputSchema fidelity,
//      argument + result + error + content-block forwarding to the right adapter
//   2. an identically-named tool on A and B — qualification and exact dispatch,
//      with no silent shadowing

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  FIXTURE_B, startGateway, startHttpUpstream, withSession,
} from "./_aggregate-helpers.mjs";

// Fixed ports: `node --test` runs files concurrently, so this must not collide
// with the other gateway-spawning suites (31234 in mcp-http-call-routing).
const GATEWAY_PORT = 31567;

const ALPHA_PING = {
  name: "ping",
  title: "Alpha Ping",
  description: "Upstream A liveness probe. Shares its name with upstream B on purpose.",
  inputSchema: {
    type: "object",
    properties: { seq: { type: "integer", minimum: 1 } },
    required: ["seq"],
  },
  annotations: { title: "Alpha Ping", readOnlyHint: true },
  _meta: { "upstream-origin": "alpha" },
};

const ALPHA_LOOKUP = {
  name: "alpha_lookup",
  title: "Alpha Lookup",
  description: "Non-trivial schema: nested object, array, enum, numeric bounds.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
      mode: { type: "string", enum: ["fast", "deep"] },
      filters: {
        type: "object",
        properties: {
          region: { type: "string", enum: ["cn", "us", "eu"] },
          since: { type: "string", format: "date-time" },
        },
        required: ["region"],
        additionalProperties: false,
      },
      symbols: { type: "array", items: { type: "string" }, minItems: 1 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  _meta: { "upstream-origin": "alpha" },
};

const ALPHA_REPORT = {
  name: "alpha_report",
  description: "Returns text + image + structuredContent for block-fidelity checks.",
  inputSchema: {
    type: "object",
    properties: { kind: { type: "string", enum: ["png", "text"] } },
    required: ["kind"],
  },
};

const ALPHA_BOOM = {
  name: "alpha_boom",
  description: "Always fails with isError=true.",
  inputSchema: { type: "object", properties: {} },
};

const ALPHA_TOOLS = [ALPHA_PING, ALPHA_LOOKUP, ALPHA_REPORT, ALPHA_BOOM];

const BETA_TOOL_NAMES = [
  "ping", "beta_echo", "beta_report", "beta_boom", "beta_bad", "beta_hang", "beta_exit",
];

const EXPECTED_QUALIFIED = [
  "alpha__alpha_boom", "alpha__alpha_lookup", "alpha__alpha_report", "alpha__ping",
  "beta__beta_bad", "beta__beta_boom", "beta__beta_echo", "beta__beta_exit",
  "beta__beta_hang", "beta__beta_report", "beta__ping",
].sort();

function writeTwoUpstreamBox(boxPath, alphaUrl) {
  writeFileSync(boxPath, [
    "name: eli467-two-upstream",
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
    // Literal dummy, written into a throwaway tmpdir — no production secret is
    // read or printed anywhere in this suite. (`auth.mode: none` is not usable
    // on the HTTP transport: authorized() still 401s, see ELI-467 report.)
    "  token: eli467-dummy-token",
    "naming:",
    "  separator: __",
    "  collision_policy: prefix_upstream",
    "",
  ].join("\n"), "utf8");
}

// Every downstream call in this file authenticates with the dummy token above.
const DOWNSTREAM = { token: "eli467-dummy-token" };

test("ELI-467: one YAML + two upstreams -> one downstream endpoint serving the union", async (t) => {
  const alpha = await startHttpUpstream({
    tools: ALPHA_TOOLS,
    label: "alpha",
    onCall(name, args) {
      if (name === "alpha_report") {
        return {
          result: {
            content: [
              { type: "text", text: `alpha-report:${args.kind}` },
              {
                type: "image",
                mimeType: "image/png",
                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
              },
            ],
            structuredContent: { upstream: "alpha", kind: args.kind },
          },
        };
      }
      if (name === "alpha_boom") {
        return {
          result: {
            isError: true,
            content: [{ type: "text", text: "alpha upstream refused the call" }],
          },
        };
      }
      return null;  // fall through to the generic handler
    },
  });
  const workdir = mkdtempSync(resolve(tmpdir(), "cli2mcp-eli467-"));
  const boxPath = resolve(workdir, "box.yaml");
  writeTwoUpstreamBox(boxPath, alpha.url);
  const gw = await startGateway({ boxPath, port: GATEWAY_PORT });

  try {
    await gw.waitReady();

    await t.test("config check agrees: 2 services, one endpoint", async () => {
      const { spawnSync } = await import("node:child_process");
      const { SERVER_ENTRY } = await import("./_aggregate-helpers.mjs");
      const r = spawnSync(process.execPath, [SERVER_ENTRY, "config", "check", "--config", boxPath],
        { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /services:\s+2/);
      assert.match(r.stdout, /alpha: mcp-http/);
      assert.match(r.stdout, /beta: mcp-stdio/);
    });

    await t.test("tools/list is the union of both upstreams, namespaced", async () => {
      const listed = await withSession(GATEWAY_PORT, DOWNSTREAM, async (mcp) => {
        const { tools } = await mcp.listTools();
        return tools;
      });
      const names = listed.map((x) => x.name).sort();
      assert.deepEqual(names, EXPECTED_QUALIFIED);
      // No raw, unqualified upstream name may leak into the downstream catalog.
      assert.equal(names.filter((n) => !n.includes("__")).length, 0);
    });

    await t.test("inputSchema is preserved verbatim from the owning upstream", async () => {
      const listed = await withSession(GATEWAY_PORT, DOWNSTREAM, async (mcp) =>
        (await mcp.listTools()).tools);
      const byName = new Map(listed.map((x) => [x.name, x]));

      assert.deepEqual(byName.get("alpha__alpha_lookup").inputSchema, ALPHA_LOOKUP.inputSchema);
      assert.deepEqual(byName.get("alpha__ping").inputSchema, ALPHA_PING.inputSchema);

      // Same for the stdio upstream B, whose schema only ever existed inside
      // the spawned fixture process.
      const betaEcho = byName.get("beta__beta_echo");
      assert.deepEqual(betaEcho.inputSchema, {
        type: "object",
        properties: {
          text: { type: "string", minLength: 1 },
          repeat: { type: "integer", minimum: 1, maximum: 5, default: 1 },
          tags: { type: "array", items: { type: "string" } },
          nested: {
            type: "object",
            properties: {
              region: { type: "string", enum: ["cn", "us", "eu"] },
              depth: { type: "integer" },
            },
            required: ["region"],
          },
        },
        required: ["text"],
      });

      // Every advertised tool declares an object schema, including the ones
      // whose upstream declaration omitted `required`.
      for (const tool of listed) assert.equal(tool.inputSchema.type, "object");
    });

    await t.test("colliding tool name is qualified per upstream and dispatches exactly", async () => {
      await withSession(GATEWAY_PORT, DOWNSTREAM, async (mcp) => {
        const alphaCall = await mcp.callTool("alpha__ping", { seq: 7 });
        const betaCall = await mcp.callTool("beta__ping", { seq: 7 });

        assert.equal(alphaCall.result.content[0].text, "alpha:ping");
        assert.deepEqual(alphaCall.result.structuredContent, {
          upstream: "alpha", received: { seq: 7 },
        });

        assert.equal(betaCall.result.content[0].text, "pong-from-beta seq=7");
        assert.deepEqual(betaCall.result.structuredContent, { upstream: "beta", seq: 7 });

        // No silent shadowing: calling beta__ping must not touch upstream A.
        assert.deepEqual(alpha.callLog.filter((c) => c.name === "ping").map((c) => c.args), [{ seq: 7 }]);
      });
    });

    await t.test("arguments reach the originating adapter unmodified", async () => {
      const args = {
        text: "hello-世界",
        repeat: 3,
        tags: ["a", "b"],
        nested: { region: "cn", depth: 2 },
      };
      await withSession(GATEWAY_PORT, DOWNSTREAM, async (mcp) => {
        const r = await mcp.callTool("beta__beta_echo", args);
        assert.equal(r.result.content[0].text, "hello-世界hello-世界hello-世界");
        // Round-tripped through a child process and back — any coercion or
        // re-keying by the gateway would show up here.
        assert.deepEqual(r.result.structuredContent.received, args);
      });

      const lookupArgs = {
        query: "700",
        limit: 3,
        mode: "deep",
        filters: { region: "us", since: "2026-01-01T00:00:00Z" },
        symbols: ["AAA", "BBB"],
      };
      await withSession(GATEWAY_PORT, DOWNSTREAM, async (mcp) => {
        const r = await mcp.callTool("alpha__alpha_lookup", lookupArgs);
        assert.equal(r.result.content[0].text, "alpha:alpha_lookup");
        assert.deepEqual(r.result.structuredContent.received, lookupArgs);
      });
      assert.deepEqual(alpha.callLog.find((c) => c.name === "alpha_lookup").args, lookupArgs);
    });

    await t.test("non-text content blocks survive both hops", async () => {
      await withSession(GATEWAY_PORT, DOWNSTREAM, async (mcp) => {
        for (const [tool, kind] of [["alpha__alpha_report", "png"], ["beta__beta_report", "png"]]) {
          const r = await mcp.callTool(tool, { kind });
          assert.ok(r.result, `expected a result for ${tool}`);
          const text = r.result.content.find((c) => c.type === "text");
          const image = r.result.content.find((c) => c.type === "image");
          assert.ok(text, `${tool}: text block missing`);
          assert.ok(image, `${tool}: image block missing`);
          assert.equal(image.mimeType, "image/png");
          assert.ok(image.data.length > 0, `${tool}: image payload empty`);
          assert.equal(text.text, `${tool.split("__")[0]}-report:png`);
          assert.ok(r.result.structuredContent, `${tool}: structuredContent lost`);
        }
      });
    });

    await t.test("upstream errors are surfaced, not swallowed", async () => {
      await withSession(GATEWAY_PORT, DOWNSTREAM, async (mcp) => {
        const boom = await mcp.callTool("alpha__alpha_boom", {});
        assert.equal(boom.result.isError, true);
        assert.equal(boom.result.content[0].text, "alpha upstream refused the call");

        const boomB = await mcp.callTool("beta__beta_boom", {});
        assert.equal(boomB.result.isError, true);
        assert.equal(boomB.result.content[0].text, "beta upstream refused the call");

        // A JSON-RPC level failure from one upstream must reach the client as
        // an error, not be converted into a silent empty success.
        const bad = await mcp.callTool("beta__beta_bad", {});
        assert.ok(bad.rpcError, `expected a JSON-RPC error, got ${JSON.stringify(bad)}`);
        assert.match(bad.rpcError.message, /beta upstream rejected the arguments/);

        // Health after all those failures — the endpoint is still serving.
        const health = await mcp.listTools();
        assert.equal(health.tools.length, EXPECTED_QUALIFIED.length);
      });
    });
  } finally {
    await gw.stop();
    rmSync(workdir, { recursive: true, force: true });
    await alpha.close();
  }
});

test("ELI-467: upstream tool metadata (title / annotations / _meta) survives tools/list", async () => {
  const alpha = await startHttpUpstream({ tools: ALPHA_TOOLS, label: "alpha" });
  const workdir = mkdtempSync(resolve(tmpdir(), "cli2mcp-eli467-meta-"));
  const boxPath = resolve(workdir, "box.yaml");
  writeTwoUpstreamBox(boxPath, alpha.url);
  const gw = await startGateway({ boxPath, port: GATEWAY_PORT });
  try {
    await gw.waitReady();
    const listed = await withSession(GATEWAY_PORT, DOWNSTREAM, async (mcp) =>
      (await mcp.listTools()).tools);
    const byName = new Map(listed.map((x) => [x.name, x]));

    // mcp-http upstream A.
    assert.equal(byName.get("alpha__alpha_lookup").title, ALPHA_LOOKUP.title);
    assert.deepEqual(byName.get("alpha__alpha_lookup").annotations, ALPHA_LOOKUP.annotations);
    assert.deepEqual(byName.get("alpha__alpha_lookup")._meta, ALPHA_LOOKUP._meta);
    assert.equal(byName.get("alpha__ping").title, ALPHA_PING.title);

    // mcp-stdio upstream B, whose metadata only ever existed inside the
    // spawned fixture process — it has to survive the stdio boundary too.
    assert.equal(byName.get("beta__ping").title, "Beta Ping");
    assert.deepEqual(byName.get("beta__ping").annotations, { title: "Beta Ping", readOnlyHint: true });
    assert.deepEqual(byName.get("beta__ping")._meta, { "upstream-origin": "beta" });
    assert.equal(byName.get("beta__beta_echo").title, "Beta Echo");

    // The gateway's internal routing state must stay internal.
    for (const tool of listed) assert.equal(tool.dispatch, undefined, `${tool.name} leaked dispatch`);

    // Tools that declare no metadata gain no empty placeholders, so the
    // help-derived `cli` catalog and plain upstream tools are byte-identical
    // to what they were before this passthrough existed.
    const plain = byName.get("alpha__alpha_boom");
    assert.deepEqual(Object.keys(plain).sort(), ["description", "inputSchema", "name"]);
  } finally {
    await gw.stop();
    rmSync(workdir, { recursive: true, force: true });
    await alpha.close();
  }
});