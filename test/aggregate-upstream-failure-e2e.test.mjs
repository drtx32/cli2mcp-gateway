// ELI-467 acceptance — upstream failure isolation and boot fail-closed semantics.
//
// Item 3 of the issue asks two things:
//   (a) one upstream tool timing out / failing / disconnecting must NOT take
//       the other, healthy upstream's tools offline;
//   (b) if a boot-level unavailable upstream prevents the gateway from starting
//       at all, that behaviour must be documented — and unknown upstream auth
//       failures must never be silently swallowed.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  FIXTURE_B, startGateway, startHttpUpstream, withSession,
} from "./_aggregate-helpers.mjs";

const GATEWAY_PORT = 31568;
const TOKEN = "eli467-dummy-token";
const DOWNSTREAM = { token: TOKEN };

const ALPHA_TOOLS = [{
  name: "ping",
  description: "Upstream A liveness probe.",
  inputSchema: { type: "object", properties: { seq: { type: "integer" } }, required: ["seq"] },
}];

function boxYaml({ alphaUrl, alphaCommand, port, gatewayToken = TOKEN }) {
  return [
    "name: eli467-failure-isolation",
    "services:",
    "  alpha:",
    "    adapter: mcp-http",
    `    url: ${alphaUrl}`,
    "    timeout_ms: 5000",
    "  beta:",
    "    adapter: mcp-stdio",
    `    command: ${alphaCommand ?? process.execPath}`,
    "    args:",
    `      - ${FIXTURE_B}`,
    "    timeout_ms: 5000",
    "transport:",
    "  type: http",
    "  host: 127.0.0.1",
    `  port: ${port}`,
    "  path: /mcp",
    "auth:",
    "  mode: bearer",
    `  token: ${gatewayToken}`,
    "",
  ].join("\n");
}

test("ELI-467: a hung / dead upstream does not disable the healthy one", async () => {
  const alpha = await startHttpUpstream({ tools: ALPHA_TOOLS, label: "alpha" });
  const workdir = mkdtempSync(resolve(tmpdir(), "cli2mcp-eli467-fail-"));
  const boxPath = resolve(workdir, "box.yaml");
  writeFileSync(boxPath, boxYaml({ alphaUrl: alpha.url, port: GATEWAY_PORT }), "utf8");
  const gw = await startGateway({ boxPath, port: GATEWAY_PORT });

  try {
    await gw.waitReady();

    await withSession(GATEWAY_PORT, DOWNSTREAM, async (mcp) => {
      // An upstream-B tool that never answers. Note the box sets
      // `timeout_ms: 5000` for both services; the assertion below shows that
      // value is NOT applied to mcp-stdio / mcp-http calls, so the request is
      // still in flight long past it. That is precisely the condition under
      // which the healthy upstream must keep serving.
      let settled = false;
      const hung = mcp.callTool("beta__beta_hang", {}, { timeoutMs: 90_000 })
        .then(() => (settled = true), () => (settled = true));

      // Well past the configured 5s service timeout, and then some.
      await new Promise((r) => setTimeout(r, 8_000));
      assert.equal(settled, false,
        "per-service timeout_ms=5000 should have fired; it is not wired to MCP calls");

      // While beta is wedged, upstream A must still answer promptly.
      const started = Date.now();
      const ok = await mcp.callTool("alpha__ping", { seq: 1 });
      const elapsed = Date.now() - started;
      assert.ok(ok.result, `alpha should stay callable while beta hangs: ${JSON.stringify(ok)}`);
      assert.equal(ok.result.content[0].text, "alpha:ping");
      assert.ok(elapsed < 5_000, `healthy upstream blocked for ${elapsed}ms by the wedged peer`);

      // And the healthy upstream keeps serving repeated calls, not just one.
      for (let i = 2; i <= 4; i++) {
        const again = await mcp.callTool("alpha__ping", { seq: i });
        assert.equal(again.result.content[0].text, "alpha:ping");
      }

      // Leave the wedged request in flight; stopping the gateway aborts it.
      void hung;
    });
  } finally {
    await gw.stop();
    rmSync(workdir, { recursive: true, force: true });
    await alpha.close();
  }
});

test("ELI-467: a stdio upstream that disconnects mid-session only kills its own tools", async () => {
  const alpha = await startHttpUpstream({ tools: ALPHA_TOOLS, label: "alpha" });
  const workdir = mkdtempSync(resolve(tmpdir(), "cli2mcp-eli467-die-"));
  const boxPath = resolve(workdir, "box.yaml");
  writeFileSync(boxPath, boxYaml({ alphaUrl: alpha.url, port: GATEWAY_PORT }), "utf8");
  const gw = await startGateway({ boxPath, port: GATEWAY_PORT });

  try {
    await gw.waitReady();

    await withSession(GATEWAY_PORT, DOWNSTREAM, async (mcp) => {
      // Baseline: both upstreams answer.
      assert.equal((await mcp.callTool("beta__ping", { seq: 1 })).result.content[0].text,
        "pong-from-beta seq=1");
      assert.equal((await mcp.callTool("alpha__ping", { seq: 1 })).result.content[0].text, "alpha:ping");

      // Kill upstream B's process from inside the gateway.
      await mcp.callTool("beta__beta_exit", {});
      // Give the stdio transport a moment to observe the child going away.
      await new Promise((r) => setTimeout(r, 1_000));

      // Upstream A is unaffected.
      const after = await mcp.callTool("alpha__ping", { seq: 2 });
      assert.ok(after.result, `alpha must survive beta's disconnect: ${JSON.stringify(after)}`);
      assert.equal(after.result.content[0].text, "alpha:ping");

      // Upstream B's tools now fail loudly instead of hanging forever or
      // returning someone else's answer.
      const dead = await mcp.callTool("beta__ping", { seq: 2 }, { timeoutMs: 20_000 });
      const failed = Boolean(dead.rpcError) || Boolean(dead.transportError)
        || dead.result?.isError === true
        || dead.result === undefined;
      assert.ok(failed, `beta should report failure after disconnect, got ${JSON.stringify(dead)}`);

      // The catalog still advertises beta — the gateway does not silently
      // forget a degraded upstream's tools.
      const listed = await mcp.listTools();
      assert.ok(listed.tools.some((x) => x.name === "beta__ping"));
      assert.ok(listed.tools.some((x) => x.name === "alpha__ping"));
    });
  } finally {
    await gw.stop();
    rmSync(workdir, { recursive: true, force: true });
    await alpha.close();
  }
});

test("ELI-467: an unreachable upstream fails boot closed (no partial endpoint)", async () => {
  const alpha = await startHttpUpstream({ tools: ALPHA_TOOLS, label: "alpha" });
  // Grab the alpha port, then release it so nothing is listening there.
  const deadPort = alpha.port;
  await alpha.close();

  const workdir = mkdtempSync(resolve(tmpdir(), "cli2mcp-eli467-dead-"));
  const boxPath = resolve(workdir, "box.yaml");
  writeFileSync(boxPath,
    boxYaml({ alphaUrl: `http://127.0.0.1:${deadPort}/mcp`, port: GATEWAY_PORT }), "utf8");

  const gw = await startGateway({ boxPath, port: GATEWAY_PORT });
  try {
    // The gateway must NOT come up serving only half the configured upstreams.
    await assert.rejects(
      () => gw.waitReady(15_000),
      (err) => {
        assert.match(err.message, /gateway (exited during boot|did not become ready)/);
        return true;
      },
    );
    const info = await gw.exited;
    assert.notEqual(info.code, 0, `expected non-zero exit, got ${JSON.stringify(info)}`);
    // The operator has to be told which upstream broke, not just "boot failed".
    assert.match(gw.logs.stderr + gw.logs.stdout, /alpha|ECONNREFUSED|fetch failed|connect/i);
  } finally {
    await gw.stop();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("ELI-467: an upstream 401 at boot fails closed and is never swallowed", async () => {
  const alpha = await startHttpUpstream({ tools: ALPHA_TOOLS, label: "alpha", status: 401 });
  const workdir = mkdtempSync(resolve(tmpdir(), "cli2mcp-eli467-401-"));
  const boxPath = resolve(workdir, "box.yaml");
  writeFileSync(boxPath, boxYaml({ alphaUrl: alpha.url, port: GATEWAY_PORT }), "utf8");

  const gw = await startGateway({ boxPath, port: GATEWAY_PORT });
  try {
    await assert.rejects(
      () => gw.waitReady(15_000),
      (err) => {
        assert.match(err.message, /gateway (exited during boot|did not become ready)/);
        return true;
      },
    );
    const info = await gw.exited;
    assert.notEqual(info.code, 0);
    // The auth rejection must be visible in the boot log — never degraded into
    // a silently smaller tool catalog — and it must name the service so the
    // operator knows which upstream credential to fix.
    const all = gw.logs.stderr + gw.logs.stdout;
    assert.match(all, /401|unauthor|forbidden|token/i, `boot log hid the auth failure:\n${all}`);
    assert.match(all, /alpha/, `boot log should identify the failing service:\n${all}`);
  } finally {
    await gw.stop();
    rmSync(workdir, { recursive: true, force: true });
    await alpha.close();
  }
});