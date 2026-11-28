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
  "sample-2097152": 2097152, "ashare-array": 713906, "files-59611": 59611 })[sample];
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
if (sample === "ashare-array") value = Array.from({ length: 1500 }, (_, i) => ({ code: "600" + String(i).padStart(3, "0"), price: 10 + i / 100, change_pct: i / 10, name: "样本" + i }));
if (sample === "envelope" || sample === "empty-envelope" || sample === "reordered-envelope") {
  value = { isMcpEnvelope: true, result: {
    content: sample === "empty-envelope" ? [] : [{ type: "text", text: sample === "reordered-envelope" ? "reordered-ok" : "envelope-ok" }],
    ...(sample === "empty-envelope" ? {} : { structuredContent: { fileCount: files.length, label: "fixture" } }),
    isError: false,
  } };
  if (sample === "reordered-envelope") value = { version: 1, result: value.result, isMcpEnvelope: true };
}
if (sample === "structured-array") value = [1, { content: "field", unicode: "🌱" }];
if (sample === "structured-scalar") value = "scalar value";
if (sample === "structured-null") value = null;
if (sample === "image-envelope") value = {
  isMcpEnvelope: true,
  result: { content: [
    { type: "text", text: "image fixture" },
    { type: "image", mimeType: "image/png", data: "AAECAw==" },
  ] },
};
if (sample === "audio-envelope") value = {
  isMcpEnvelope: true,
  result: { content: [{ type: "audio", mimeType: "audio/wav", data: "UklGRg==" }] },
};
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
  op, sample, cliArgv: argv, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
  exitCode: 0, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
  bodySha256: createHash("sha256").update(body).digest("hex"), fileCount: files.length,
}) + "\n");
`;
const TEST_TOKEN = "eli571-fixture-token";

test("triple-mode multica_run exposes responseMode and adapts CLI results over MCP wire", async () => {
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
    "    tool_mode: triple", "    auto_json: true", "    timeout_ms: 1000", "    max_output_bytes: 16000",
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
      const runTool = (await listTools()).tools.find((tool) => tool.name === "multica_run");
      const runSchema = runTool.inputSchema;
      assert.equal("output_offset" in runSchema.properties, false);
      assert.equal("output_limit" in runSchema.properties, false);
      assert.deepEqual(runSchema.properties.responseMode.enum, ["auto", "text", "structured", "mcp"]);
      assert.match(runSchema.properties.responseMode.description, /not passed to the CLI/);
      assert.match(runTool.description, /Gateway-only responseMode/);
      for (const advice of ["Prefer structured", "--output json", "--format json", "--with-content when JSON is expected", "Prefer text", "Use mcp", "Use auto", "Native envelopes take precedence", "Gateway-only, not CLI args"]) {
        assert.ok(runSchema.properties.responseMode.description.includes(advice), `schema responseMode guidance missing ${advice}`);
        assert.ok(runTool.description.includes(advice), `tools/list description missing ${advice}`);
      }
      assert.equal(runTool.outputSchema, undefined);

      const help = await callTool("multica_help", {});
      assert.match(help.result.content[0].text, /responseMode is a Gateway-only parameter/);
      for (const advice of ["Prefer structured", "--output json", "--format json", "--with-content when JSON is expected", "Prefer text", "Use mcp", "Use auto", "Native envelopes take precedence", "Gateway-only, not CLI args"]) {
        assert.ok(help.result.content[0].text.includes(advice), `_help guidance missing ${advice}`);
      }
      assert.match(help.result.content[0].text, /raw help below documents CLI arguments only/);

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
      assert.deepEqual(metadata.result.structuredContent, { data: metadataJson }, "legacy caller receives JSON adaptation without responseMode");

      const structuredObject = await call(["skill", "get"], ["metadata", "--output", "json"], { responseMode: "structured" });
      const structuredText = structuredObject.result.content[0].text;
      assert.deepEqual(structuredObject.result.structuredContent, { data: JSON.parse(structuredText) });
      assert.equal(structuredObject.result.structuredContent.data.id, "metadata");
      const structuredArray = await call(["skill", "get"], ["structured-array"], { responseMode: "structured" });
      assert.deepEqual(structuredArray.result.structuredContent, { data: [1, { content: "field", unicode: "🌱" }] });
      assert.equal(structuredArray.result.content[0].text, '[1,{"content":"field","unicode":"🌱"}]');
      const structuredScalar = await call(["skill", "get"], ["structured-scalar"], { responseMode: "structured" });
      assert.deepEqual(structuredScalar.result.structuredContent, { data: "scalar value" });
      const structuredNull = await call(["skill", "get"], ["structured-null"], { responseMode: "structured" });
      assert.deepEqual(structuredNull.result.structuredContent, { data: null });
      const textMode = await call(["skill", "get"], ["metadata", "--output", "json"], { responseMode: "text" });
      assert.equal(textMode.result.structuredContent, undefined);
      assert.equal(textMode.result.content[0].text, structuredText);

      for (const targetBytes of [7311, 26778, 30496, 69642, 131072, 2097152]) {
        const sample = `sample-${targetBytes}`;
        const response = await call(["skill", "get"], [sample, "--with-content", "--output", "json"]);
        assert.equal(Boolean(response.result.isError), false, sample);
        const json = JSON.parse(response.result.content[0].text);
        assert.deepEqual(response.result.structuredContent, { data: json }, sample);
        assert.equal(Buffer.byteLength(response.result.content[0].text), targetBytes, sample);
        assert.equal(json.files.length, 18, sample);
        const repeatCount = targetBytes === 7311 ? 12 : targetBytes === 26778 ? 64
          : targetBytes === 30496 ? 128 : targetBytes === 69642 ? 256 : 4;
        assert.equal(createHash("sha256").update(json.content).digest("hex"),
          createHash("sha256").update("技能正文🌱".repeat(repeatCount)).digest("hex"), sample);
        assert.ok(response.roundTripMs > 0);
        if (targetBytes === 2097152) {
          const textCopyBytes = Buffer.byteLength(response.result.content[0].text);
          const structuredCopyBytes = Buffer.byteLength(JSON.stringify(response.result.structuredContent));
          assert.ok(textCopyBytes + structuredCopyBytes > targetBytes * 1.8, "dual representation has material wire/serialization overhead");
        }
      }
      const oversizedAuditCount = readFileSync(auditPath, "utf8").trim().split("\n")
        .map((line) => JSON.parse(line)).filter((row) => row.sample === "sample-2097152").length;
      assert.equal(oversizedAuditCount, 1, "oversized _run output must not cause command replay");

      const fileList = await call(["skill", "files", "list"], ["files-59611", "--with-content", "--output", "json"]);
      assert.equal(Boolean(fileList.result.isError), false);
      const recoveredFiles = JSON.parse(fileList.result.content[0].text);
      assert.equal(recoveredFiles.length, 18);
      assert.equal(Buffer.byteLength(fileList.result.content[0].text), 59611);

      const ashareArray = await call(["stock", "list"], ["ashare-array", "--output", "json"]);
      assert.equal(Buffer.byteLength(ashareArray.result.content[0].text), 713906);
      assert.equal(ashareArray.result.structuredContent.data.length, 1500);
      assert.ok(Buffer.byteLength(JSON.stringify(ashareArray.result.structuredContent)) > 713000,
        "AShare-sized array is carried in a second structured representation");

      const marker = await call(["skill", "get"], ["marker", "--with-content", "--output", "json"]);
      assert.equal(Boolean(marker.result.isError), false);
      const markerJson = JSON.parse(marker.result.content[0].text);
      assert.equal(markerJson.content, 'fixture contains "isMcpEnvelope" and true as body text');

      const envelope = await call(["skill", "get"], ["envelope", "--with-content", "--output", "json"]);
      assert.deepEqual(envelope.result.content, [{ type: "text", text: "envelope-ok" }]);
      assert.deepEqual(envelope.result.structuredContent, { fileCount: 18, label: "fixture" });
      assert.equal(envelope.result.isError, false);
      const nativePriority = await call(["skill", "get"], ["envelope"], { responseMode: "structured" });
      assert.deepEqual(nativePriority.result.structuredContent, { fileCount: 18, label: "fixture" });
      const imageEnvelope = await call(["skill", "get"], ["image-envelope"], { responseMode: "mcp" });
      assert.deepEqual(imageEnvelope.result.content, [
        { type: "text", text: "image fixture" },
        { type: "image", mimeType: "image/png", data: "AAECAw==" },
      ]);
      const audioEnvelope = await call(["skill", "get"], ["audio-envelope"]);
      assert.deepEqual(audioEnvelope.result.content, [{ type: "audio", mimeType: "audio/wav", data: "UklGRg==" }]);
      const mcpRequired = await call(["skill", "get"], ["metadata"], { responseMode: "mcp" });
      assert.equal(mcpRequired.result.structuredContent.error, "mcp_envelope_required");
      const malformedStructured = await call(["skill", "get"], ["badjson"], { responseMode: "structured" });
      assert.equal(malformedStructured.result.structuredContent.error, "invalid_json");

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

      const timeout = await call(["skill", "get"], ["timeout", "--output", "json"], { responseMode: "structured" });
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
    for (const row of rows) assert.equal(row.cliArgv.includes("responseMode"), false, "Gateway responseMode must not reach CLI argv");
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

test("dual-mode _run exposes the same responseMode wire contract without workspace", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "cli2mcp-dual-response-"));
  const port = await freePort();
  const command = resolve(dir, "fixture");
  const token = "dual-response-fixture-token";
  writeFileSync(command, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("--help")) process.stdout.write("Usage: fixture <subcommand>\\n");
else process.stdout.write(JSON.stringify({ content: "business key", value: "large enough" }));
`, "utf8");
  chmodSync(command, 0o755);
  const boxPath = resolve(dir, "box.yaml");
  writeFileSync(boxPath, [
    "name: dual-response-fixture", "services:", "  fixture:", "    adapter: cli",
    `    command: ${JSON.stringify(command)}`, "    tool_mode: dual", "    max_output_bytes: 4",
    "transport:", "  type: http", "  host: 127.0.0.1", `  port: ${port}`, "  path: /mcp",
    "auth:", "  mode: bearer", `  token: ${token}`, "naming:", "  auto_unwrap_single_service: true", "",
  ].join("\n"), "utf8");
  const gateway = await startGateway({ boxPath, port });
  try {
    await gateway.waitReady();
    await withSession(port, { token }, async ({ listTools, callTool }) => {
      const tools = (await listTools()).tools;
      assert.deepEqual(tools.map((tool) => tool.name), ["fixture_help", "fixture_run"]);
      const run = tools.find((tool) => tool.name === "fixture_run");
      assert.deepEqual(run.inputSchema.properties.responseMode.enum, ["auto", "text", "structured", "mcp"]);
      const result = await callTool("fixture_run", {
        commandPath: ["json"], args: [], responseMode: "structured",
      });
      assert.deepEqual(result.result.structuredContent, { data: { content: "business key", value: "large enough" } });
      assert.equal(result.result.content[0].text, '{"content":"business key","value":"large enough"}');
    });
  } finally {
    await gateway.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
