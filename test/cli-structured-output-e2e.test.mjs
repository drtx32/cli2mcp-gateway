import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { startGateway, withSession } from "./_aggregate-helpers.mjs";

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

test("opt-in CLI JSON output preserves text and adds schema-conforming structuredContent", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "cli2mcp-structured-output-"));
  const port = await freePort();
  const command = resolve(dir, "fixture");
  const token = "structured-output-fixture-token";
  writeFileSync(command, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stdout.write(args.length > 1 ? "Usage: fixture json\\nOptions:\\n  --kind KIND\\n" : "Usage: fixture <command>\\nCommands:\\n  json\\n");
} else if (args.includes("--kind") && args[args.indexOf("--kind") + 1] === "array") process.stdout.write('[1,{"content":"kept"}]');
else if (args.includes("--kind") && args[args.indexOf("--kind") + 1] === "scalar") process.stdout.write('"value"');
else if (args.includes("--kind") && args[args.indexOf("--kind") + 1] === "null") process.stdout.write('null');
else if (args.includes("--kind") && args[args.indexOf("--kind") + 1] === "invalid") process.stdout.write('{broken');
else if (args.includes("--kind") && args[args.indexOf("--kind") + 1] === "failure") { process.stdout.write('{"content":"failure"}'); process.exit(4); }
else if (args.includes("--kind") && args[args.indexOf("--kind") + 1] === "envelope") process.stdout.write('{"isMcpEnvelope":true,"result":{"content":[{"type":"text","text":"native"}]}}');
else if (args.includes("--kind") && args[args.indexOf("--kind") + 1] === "large") process.stdout.write(JSON.stringify({content:"x".repeat(48000),ok:true}));
else process.stdout.write(JSON.stringify({content:"business field", nested:{items:[1,"🌱"]}, ok:true}));
`, "utf8");
  chmodSync(command, 0o755);
  const boxPath = resolve(dir, "box.yaml");
  writeFileSync(boxPath, [
    "name: structured-output-fixture", "services:", "  fixture:", "    adapter: cli",
    `    command: ${JSON.stringify(command)}`, "    subcommands: [json]", "    structured_output_tools: [fixture_json]", "    max_output_bytes: 65536",
    "transport:", "  type: http", "  host: 127.0.0.1", `  port: ${port}`, "  path: /mcp",
    "auth:", "  mode: bearer", `  token: ${token}`, "naming:",
    "  auto_unwrap_single_service: true", "",
  ].join("\n"), "utf8");
  const gateway = await startGateway({ boxPath, port });
  try {
    await gateway.waitReady();
    await withSession(port, { token }, async ({ listTools, callTool }) => {
      const listed = (await listTools()).tools;
      const spec = listed.find((tool) => tool.name.endsWith("json"));
      assert.ok(spec, `expected json CLI tool, got ${listed.map((tool) => tool.name).join(", ")}`);
      assert.deepEqual(spec.outputSchema, { type: "object", additionalProperties: true }, `tool=${spec.name}`);
      const text = JSON.stringify({content:"business field", nested:{items:[1,"🌱"]}, ok:true});
      const object = await callTool(spec.name, {});
      assert.ok(object.result, JSON.stringify(object));
      assert.equal(Boolean(object.result.isError), false);
      assert.equal(object.result.content[0].text, text);
      assert.deepEqual(object.result.structuredContent, JSON.parse(text));

      for (const kind of ["array", "scalar", "null", "invalid", "envelope"]) {
        const response = await callTool(spec.name, { kind });
        assert.equal(Boolean(response.result.isError), true, `${kind}: ${JSON.stringify(response)}`);
        assert.equal(response.result.structuredContent, undefined, kind);
        assert.equal(response.result.content[0].text, kind === "array" ? '[1,{"content":"kept"}]'
          : kind === "scalar" ? '"value"' : kind === "null" ? "null" : kind === "envelope"
            ? '{"isMcpEnvelope":true,"result":{"content":[{"type":"text","text":"native"}]}}' : "{broken", kind);
      }
      const large = await callTool(spec.name, { kind: "large" });
      assert.equal(Boolean(large.result.isError), false);
      assert.equal(Buffer.byteLength(large.result.content[0].text), Buffer.byteLength(JSON.stringify({ content: "x".repeat(48000), ok: true })));
      assert.deepEqual(large.result.structuredContent, { content: "x".repeat(48000), ok: true });
      const failed = await callTool(spec.name, { kind: "failure" });
      assert.equal(Boolean(failed.result.isError), true);
      assert.equal(failed.result.structuredContent.error, "command_failed");
    });
  } finally {
    await gateway.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
