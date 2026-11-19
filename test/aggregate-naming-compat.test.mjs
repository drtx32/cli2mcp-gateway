// ELI-467 acceptance — naming-policy backward compatibility.
//
// Adding a second upstream must not change how any existing single-service box
// names or dispatches its tools. This file pins:
//   * collision_policy: prefix_upstream (default), suffix_upstream, error
//   * naming.prefix (box-level prefix)
//   * auto_unwrap_single_service on a 1-service box  (raw names, unchanged)
//   * auto_unwrap_single_service on a 2-service box (no unwrap)
//   * a 1-service mcp-stdio box, the shape every legacy deployment uses

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { FIXTURE_B, startGateway, startHttpUpstream, withSession } from "./_aggregate-helpers.mjs";

const TOKEN = "eli467-dummy-token";
const DOWNSTREAM = { token: TOKEN };

const ALPHA_TOOLS = [
  {
    name: "ping",
    description: "Upstream A ping (collides with B).",
    inputSchema: { type: "object", properties: { seq: { type: "integer" } }, required: ["seq"] },
  },
];

function box({ services, port, naming = {} }) {
  const lines = ["name: eli467-naming", "services:"];
  for (const [name, svc] of Object.entries(services)) {
    lines.push(`  ${name}:`);
    for (const [k, v] of Object.entries(svc)) {
      if (Array.isArray(v)) lines.push(`    ${k}:`, ...v.map((x) => `      - ${x}`));
      else lines.push(`    ${k}: ${v}`);
    }
  }
  lines.push(
    "transport:", "  type: http", "  host: 127.0.0.1", `  port: ${port}`, "  path: /mcp",
    "auth:", "  mode: bearer", `  token: ${TOKEN}`,
  );
  const namingKeys = Object.keys(naming);
  if (namingKeys.length) {
    lines.push("naming:");
    for (const [k, v] of Object.entries(naming)) {
      lines.push(`  ${k}: ${typeof v === "string" ? `"${v}"` : v}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function serve(yaml, port) {
  const workdir = mkdtempSync(resolve(tmpdir(), "cli2mcp-eli467-naming-"));
  const boxPath = resolve(workdir, "box.yaml");
  writeFileSync(boxPath, yaml, "utf8");
  const gw = await startGateway({ boxPath, port });
  await gw.waitReady();
  return {
    gw,
    cleanup: async () => {
      await gw.stop();
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}

const twoUpstreams = (alphaUrl) => ({
  alpha: { adapter: "mcp-http", url: alphaUrl },
  beta: { adapter: "mcp-stdio", command: process.execPath, args: [FIXTURE_B] },
});

test("ELI-467: suffix_upstream qualifies collisions from the other end and still dispatches exactly", async () => {
  const alpha = await startHttpUpstream({ tools: ALPHA_TOOLS, label: "alpha" });
  const s = await serve(
    box({ services: twoUpstreams(alpha.url), port: 31569, naming: { collision_policy: "suffix_upstream" } }),
    31569,
  );
  try {
    await withSession(31569, DOWNSTREAM, async (mcp) => {
      const names = (await mcp.listTools()).tools.map((x) => x.name);
      // `ping` exists on both upstreams; suffix policy yields two distinct ids.
      assert.ok(names.includes("ping__alpha"), `missing ping__alpha in ${names.join(", ")}`);
      assert.ok(names.includes("ping__beta"), `missing ping__beta in ${names.join(", ")}`);
      assert.equal(new Set(names).size, names.length, "suffix policy produced a duplicate id");
      // Non-colliding tools follow the same suffix shape.
      assert.ok(names.includes("beta_echo__beta"), names.join(", "));
      assert.ok(names.includes("beta_report__beta"), names.join(", "));

      assert.equal((await mcp.callTool("ping__alpha", { seq: 3 })).result.content[0].text, "alpha:ping");
      assert.equal((await mcp.callTool("ping__beta", { seq: 3 })).result.content[0].text, "pong-from-beta seq=3");
      assert.deepEqual(alpha.callLog.filter((c) => c.name === "ping").map((c) => c.args), [{ seq: 3 }]);
    });
  } finally {
    await s.cleanup();
    await alpha.close();
  }
});

test("ELI-467: naming.prefix is applied to every qualified name and dispatches exactly", async () => {
  const alpha = await startHttpUpstream({ tools: ALPHA_TOOLS, label: "alpha" });
  const s = await serve(
    box({ services: twoUpstreams(alpha.url), port: 31570, naming: { prefix: "gw." } }),
    31570,
  );
  try {
    await withSession(31570, DOWNSTREAM, async (mcp) => {
      const names = (await mcp.listTools()).tools.map((x) => x.name);
      assert.ok(names.every((n) => n.startsWith("gw.")), `prefix missing: ${names.join(", ")}`);
      assert.ok(names.includes("gw.alpha__ping"));
      assert.ok(names.includes("gw.beta__ping"));
      assert.equal((await mcp.callTool("gw.alpha__ping", { seq: 1 })).result.content[0].text, "alpha:ping");
      assert.equal((await mcp.callTool("gw.beta__ping", { seq: 1 })).result.content[0].text, "pong-from-beta seq=1");
    });
  } finally {
    await s.cleanup();
    await alpha.close();
  }
});

test("ELI-467: collision_policy=error refuses to boot on a genuine id collision", async () => {
  // `2probe` on service `up` collides with `probe` on service `up2` once the
  // separator is empty: "up" + "" + "2probe" === "up2" + "" + "probe".
  const up = await startHttpUpstream({
    tools: [{ name: "2probe", description: "collides", inputSchema: { type: "object", properties: {} } }],
    label: "up",
  });
  const up2 = await startHttpUpstream({
    tools: [{ name: "probe", description: "collides", inputSchema: { type: "object", properties: {} } }],
    label: "up2",
  });
  const workdir = mkdtempSync(resolve(tmpdir(), "cli2mcp-eli467-clash-"));
  const boxPath = resolve(workdir, "box.yaml");
  writeFileSync(boxPath, box({
    services: {
      up: { adapter: "mcp-http", url: up.url },
      up2: { adapter: "mcp-http", url: up2.url },
    },
    port: 31571,
    naming: { separator: "", collision_policy: "error" },
  }), "utf8");

  const gw = await startGateway({ boxPath, port: 31571 });
  try {
    await assert.rejects(() => gw.waitReady(15_000), /exited during boot|did not become ready/);
    const info = await gw.exited;
    assert.notEqual(info.code, 0);
    const all = gw.logs.stderr + gw.logs.stdout;
    // Fail loudly and specifically rather than dropping one of the two tools.
    assert.match(all, /collision/i, `boot log should name the collision:\n${all}`);
    assert.match(all, /up2probe/, `boot log should show the colliding id:\n${all}`);
  } finally {
    await gw.stop();
    rmSync(workdir, { recursive: true, force: true });
    await up.close();
    await up2.close();
  }
});

test("ELI-467: auto_unwrap_single_service keeps a 1-service box on raw tool names", async () => {
  // The legacy shape: one mcp-stdio service, no namespace prefix. This is what
  // every existing standalone deployment exposes and what clients are wired to.
  const s = await serve(box({
    services: { beta: { adapter: "mcp-stdio", command: process.execPath, args: [FIXTURE_B] } },
    port: 31572,
    naming: { auto_unwrap_single_service: true },
  }), 31572);
  try {
    await withSession(31572, DOWNSTREAM, async (mcp) => {
      const names = (await mcp.listTools()).tools.map((x) => x.name).sort();
      assert.deepEqual(names, [
        "beta_bad", "beta_boom", "beta_echo", "beta_exit",
        "beta_hang", "beta_report", "ping",
      ]);
      assert.equal((await mcp.callTool("ping", { seq: 2 })).result.content[0].text, "pong-from-beta seq=2");
    });
  } finally {
    await s.cleanup();
  }
});

test("ELI-467: auto_unwrap_single_service does NOT unwrap a 2-service box", async () => {
  const alpha = await startHttpUpstream({ tools: ALPHA_TOOLS, label: "alpha" });
  const s = await serve(
    box({ services: twoUpstreams(alpha.url), port: 31573, naming: { auto_unwrap_single_service: true } }),
    31573,
  );
  try {
    await withSession(31573, DOWNSTREAM, async (mcp) => {
      const names = (await mcp.listTools()).tools.map((x) => x.name);
      assert.ok(names.includes("alpha__ping"), `2-service box must stay namespaced: ${names.join(", ")}`);
      assert.ok(names.includes("beta__ping"));
      assert.equal(new Set(names).size, names.length);
      assert.equal((await mcp.callTool("alpha__ping", { seq: 1 })).result.content[0].text, "alpha:ping");
      assert.equal((await mcp.callTool("beta__ping", { seq: 1 })).result.content[0].text, "pong-from-beta seq=1");
    });
  } finally {
    await s.cleanup();
    await alpha.close();
  }
});

test("ELI-467: a 1-service box WITHOUT auto_unwrap stays prefixed (pre-feature default)", async () => {
  const s = await serve(box({
    services: { beta: { adapter: "mcp-stdio", command: process.execPath, args: [FIXTURE_B] } },
    port: 31574,
  }), 31574);
  try {
    await withSession(31574, DOWNSTREAM, async (mcp) => {
      const names = (await mcp.listTools()).tools.map((x) => x.name).sort();
      assert.ok(names.includes("beta__ping"), names.join(", "));
      assert.equal((await mcp.callTool("beta__ping", { seq: 5 })).result.content[0].text, "pong-from-beta seq=5");
    });
  } finally {
    await s.cleanup();
  }
});