import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { startGateway, withSession } from "./_aggregate-helpers.mjs";

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

const fixtureSource = String.raw`
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
const argv = process.argv.slice(2);
const started = process.hrtime.bigint();
if (argv.includes("--help")) {
  process.stdout.write("Usage: multica <command>\nCommands: skill\n");
  process.exit(0);
}
const op = argv.slice(0, 3).join(" ");
const sample = argv[1] === "files" ? (argv[3] || "files") : (argv[2] || "metadata");
if (sample === "timeout") await new Promise((resolve) => setTimeout(resolve, 2500));
if (sample === "badutf8") {
  process.stderr.write("fixture invalid UTF-8\n");
  process.stdout.write(Buffer.from([0x7b, 0xff, 0x7d]));
  process.exit(0);
}
if (sample === "nonzero") {
  process.stdout.write("fixture partial stdout\n");
  process.stderr.write("fixture controlled failure\n");
  process.exit(7);
}
const targetBytes = ({ "sample-7311": 7311, "sample-26778": 26778,
  "sample-30496": 30496, "sample-69642": 69642, "sample-131072": 131072,
  "sample-2097152": 2097152, "files-59611": 59611 })[sample];
const body = sample === "marker" ? 'fixture contains "isMcpEnvelope" and true as body text'
  : "技能正文🌱".repeat(sample === "sample-7311" ? 12 : sample === "sample-26778" ? 64
    : sample === "sample-30496" ? 128 : sample === "sample-69642" ? 256 : 4);
const files = Array.from({ length: 18 }, (_, i) => ({
  id: "f" + (i + 1), path: "ref-" + (i + 1) + ".md",
  ...(argv.includes("--with-content") ? { content: "ref-" + (i + 1) + " 内容" } : {}),
}));
let value;
if (argv[1] === "files" && argv[2] === "list") {
  value = files.map((file) => ({ ...file, content: (file.content || "附件").repeat(2) }));
} else {
  value = { id: sample, revision: 46, name: "fixture-skill", config: { enabled: true },
    ...(argv.includes("--with-content") ? { content: body } : {}), files };
}
if (sample === "envelope" || sample === "empty-envelope" || sample === "reordered-envelope") {
  value = { isMcpEnvelope: true, result: {
    content: sample === "empty-envelope" ? [] : [{ type: "text", text: sample === "reordered-envelope" ? "reordered-ok" : "envelope-ok" }],
    ...(sample === "empty-envelope" ? {} : { structuredContent: { fileCount: files.length, label: "fixture" } }),
    isError: false,
  } };
  if (sample === "reordered-envelope") value = { version: 1, result: value.result, isMcpEnvelope: true };
}
if (sample === "badjson") {
  process.stdout.write('{"content":');
  process.stderr.write("fixture malformed JSON\n");
  process.exit(0);
}
if (sample === "bad-envelope") {
  process.stdout.write('{"isMcpEnvelope":true,"result":');
  process.stderr.write("fixture malformed envelope\n");
  process.exit(0);
}
if (targetBytes) {
  const padTarget = Array.isArray(value) ? value[value.length - 1] : value;
  padTarget.padding = "";
  const baseBytes = Buffer.byteLength(JSON.stringify(value));
  padTarget.padding = "x".repeat(targetBytes - baseBytes);
}
const stdout = sample === "diagnostic-envelope"
  ? "diagnostic before\n" + JSON.stringify({ isMcpEnvelope: true, result: { content: [{ type: "text", text: "must remain text" }] } }) + "\ndiagnostic after"
  : JSON.stringify(value);
const stderr = "fixture stderr diagnostic\n";
process.stderr.write(stderr);
process.stdout.write(stdout);
appendFileSync(process.env.AUDIT_LOG, JSON.stringify({
  op, sample, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
  exitCode: 0, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
  bodySha256: createHash("sha256").update(body).digest("hex"), fileCount: files.length,
}) + "\n");
`;
const TEST_TOKEN = "eli571-fixture-token";

test("multica_run dispatch preserves complete stdout and unwraps only whole MCP envelopes", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "cli2mcp-multica-run-"));
  const port = await freePort();
  const command = resolve(dir, "multica");
  const auditPath = resolve(dir, "fixture-audit.jsonl");
  const workspace = resolve(dir, "workspace");
  writeFileSync(command, `#!${process.execPath}\n${fixtureSource}`, "utf8");
  chmodSync(command, 0o755);
  const yaml = [
    "name: multica-run-e2e",
    "services:", "  multica:", "    adapter: cli", `    command: ${JSON.stringify(command)}`,
    "    tool_mode: triple", "    timeout_ms: 1000", "    max_output_bytes: 16000",
    "    env:", `      AUDIT_LOG: ${JSON.stringify(auditPath)}`,
    "    workspace:", `      path: ${JSON.stringify(workspace)}`,
    "transport:", "  type: http", "  host: 127.0.0.1", `  port: ${port}`, "  path: /mcp",
    "auth:", "  mode: bearer", `  token: ${TEST_TOKEN}`,
    "naming:", "  auto_unwrap_single_service: true", "",
  ].join("\n");
  const boxPath = resolve(dir, "box.yaml");
  writeFileSync(boxPath, yaml, "utf8");
  const gateway = await startGateway({ boxPath, port });
  try {
    await gateway.waitReady();
    await withSession(port, { token: TEST_TOKEN }, async ({ listTools, callTool }) => {
      const toolNames = (await listTools()).tools.map((tool) => tool.name);
      assert.deepEqual(toolNames, ["multica_help", "multica_run", "multica_workspace"]);
      const runSchema = (await listTools()).tools.find((tool) => tool.name === "multica_run").inputSchema;
      assert.equal("output_offset" in runSchema.properties, false);
      assert.equal("output_limit" in runSchema.properties, false);

      const call = async (commandPath, args, extra = {}) => {
        const started = process.hrtime.bigint();
        const response = await callTool("multica_run", { commandPath, args, ...extra });
        response.roundTripMs = Number(process.hrtime.bigint() - started) / 1e6;
        return response;
      };

      const metadata = await call(["skill", "get"], ["metadata", "--output", "json"]);
      assert.ok(metadata.result, JSON.stringify({ rpcError: metadata.rpcError, transportError: metadata.transportError }));
      assert.equal(Boolean(metadata.result.isError), false);
      const metadataJson = JSON.parse(metadata.result.content[0].text);
      assert.equal(metadataJson.id, "metadata");
      assert.equal("content" in metadataJson, false);

      for (const targetBytes of [7311, 26778, 30496, 69642, 131072, 2097152]) {
        const sample = `sample-${targetBytes}`;
        const response = await call(["skill", "get"], [sample, "--with-content", "--output", "json"]);
        assert.equal(Boolean(response.result.isError), false, sample);
        assert.equal(response.result.structuredContent, undefined, sample);
        const json = JSON.parse(response.result.content[0].text);
        assert.equal(Buffer.byteLength(response.result.content[0].text), targetBytes, sample);
        assert.equal(json.files.length, 18, sample);
        const repeatCount = targetBytes === 7311 ? 12 : targetBytes === 26778 ? 64
          : targetBytes === 30496 ? 128 : targetBytes === 69642 ? 256 : 4;
        assert.equal(createHash("sha256").update(json.content).digest("hex"),
          createHash("sha256").update("技能正文🌱".repeat(repeatCount)).digest("hex"), sample);
        assert.ok(response.roundTripMs > 0);
      }
      const oversizedAuditCount = readFileSync(auditPath, "utf8").trim().split("\n")
        .map((line) => JSON.parse(line)).filter((row) => row.sample === "sample-2097152").length;
      assert.equal(oversizedAuditCount, 1, "oversized _run output must not cause command replay");

      const fileList = await call(["skill", "files", "list"], ["files-59611", "--with-content", "--output", "json"]);
      assert.equal(Boolean(fileList.result.isError), false);
      const recoveredFiles = JSON.parse(fileList.result.content[0].text);
      assert.equal(recoveredFiles.length, 18);
      assert.equal(Buffer.byteLength(fileList.result.content[0].text), 59611);

      const marker = await call(["skill", "get"], ["marker", "--with-content", "--output", "json"]);
      assert.equal(Boolean(marker.result.isError), false);
      const markerJson = JSON.parse(marker.result.content[0].text);
      assert.equal(markerJson.content, 'fixture contains "isMcpEnvelope" and true as body text');

      const envelope = await call(["skill", "get"], ["envelope", "--with-content", "--output", "json"]);
      assert.deepEqual(envelope.result.content, [{ type: "text", text: "envelope-ok" }]);
      assert.deepEqual(envelope.result.structuredContent, { fileCount: 18, label: "fixture" });
      assert.equal(envelope.result.isError, false);

      const reorderedEnvelope = await call(["skill", "get"], ["reordered-envelope", "--output", "json"]);
      assert.deepEqual(reorderedEnvelope.result.content, [{ type: "text", text: "reordered-ok" }]);

      const diagnosticEnvelope = await call(["skill", "get"], ["diagnostic-envelope"]);
      assert.equal(Boolean(diagnosticEnvelope.result.isError), false);
      assert.equal(diagnosticEnvelope.result.content[0].text,
        `diagnostic before\n${JSON.stringify({ isMcpEnvelope: true, result: { content: [{ type: "text", text: "must remain text" }] } })}\ndiagnostic after`);

      const emptyEnvelope = await call(["skill", "get"], ["empty-envelope", "--output", "json"]);
      assert.equal(emptyEnvelope.result.isError, true);
      assert.equal(emptyEnvelope.result.structuredContent.error, "empty_mcp_result");
      assert.equal(emptyEnvelope.result.structuredContent.recoverable, true);

      const badJson = await call(["skill", "get"], ["badjson", "--output", "json"]);
      assert.equal(badJson.result.isError, true);
      assert.equal(badJson.result.structuredContent.error, "invalid_json");

      const badEnvelope = await call(["skill", "get"], ["bad-envelope", "--output", "json"]);
      assert.equal(badEnvelope.result.isError, true);
      assert.equal(badEnvelope.result.structuredContent.error, "invalid_mcp_envelope");

      const badUtf8 = await call(["skill", "get"], ["badutf8"]);
      assert.equal(badUtf8.result.isError, true);
      assert.equal(badUtf8.result.structuredContent.error, "invalid_utf8");
      assert.equal(badUtf8.result.structuredContent.stdoutBytes, 3);
      assert.ok(badUtf8.result.structuredContent.stderrBytes > 0);

      const nonzero = await call(["skill", "get"], ["nonzero"]);
      assert.equal(nonzero.result.isError, true);
      assert.equal(nonzero.result.structuredContent.error, "command_failed");
      assert.equal(nonzero.result.structuredContent.exitCode, 7);
      assert.ok(nonzero.result.structuredContent.stdoutBytes > 0);
      assert.ok(nonzero.result.structuredContent.stderrBytes > 0);

      const timeout = await call(["skill", "get"], ["timeout", "--output", "json"]);
      assert.equal(timeout.result.isError, true);
      assert.equal(timeout.result.structuredContent.error, "timeout");
      assert.equal(timeout.result.structuredContent.recoverable, true);
      assert.ok(timeout.result.structuredContent.elapsedMs > 0);
      assert.equal(typeof timeout.result.structuredContent.stdoutBytes, "number");
      assert.equal(typeof timeout.result.structuredContent.stderrBytes, "number");
      assert.ok(timeout.result.structuredContent.exitCode == null || typeof timeout.result.structuredContent.exitCode === "number");

      const workspaceResult = await callTool("multica_workspace", { subcommand: "dir" });
      assert.equal(Boolean(workspaceResult.result.isError), false);
      assert.match(workspaceResult.result.content[0].text, /root/);
    });

    const rows = readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    for (const row of rows.filter((item) => !["badjson", "bad-envelope", "badutf8", "nonzero", "timeout"].includes(item.sample))) {
      assert.equal(row.exitCode, 0);
      assert.ok(row.stdoutBytes > 0);
      assert.ok(row.stderrBytes > 0);
      assert.ok(row.elapsedMs > 0);
      assert.match(row.bodySha256, /^[0-9a-f]{64}$/);
      assert.equal(row.fileCount, 18);
    }
  } finally {
    await gateway.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
