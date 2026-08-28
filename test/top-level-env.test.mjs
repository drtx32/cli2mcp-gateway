// Tests for the docker-compose-style top-level `env` and `env_file` on
// box.yaml. These feed the ${VAR} expansion context for the whole box,
// so a value declared here can be referenced from service.headers, url,
// etc. without the runner needing to pre-export it as a process env.
//
// We set the box up so that ${INHERITED_FROM_PROCESS_ENV} is only
// resolvable via process.env — its presence lets us assert the
// process.env fallback is wired up. Setting it in the test file scope
// before loadBoxConfig is called is enough; process.env is shared.

process.env.INHERITED_FROM_PROCESS_ENV = "from-process-env";

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { loadBoxConfig } from "../src/box-config.mjs";

const tmp = mkdtempSync(resolve(tmpdir(), "cli2mcp-tl-env-"));
const envFile = resolve(tmp, "creds.env");
writeFileSync(envFile, [
  "GANGTISE_ACCESS_KEY=ak-from-file",
  "GANGTISE_SECRET_KEY=sk-from-file",
  "",
].join("\n"));

const boxPath = resolve(tmp, "box.yaml");
writeFileSync(boxPath, [
  "name: tl-env-box",
  "env_file:",
  `  - ${envFile}`,
  "env:",
  "  GANGTISE_ACCESS_KEY: ak-from-inline-override",
  "services:",
  "  upstream:",
  "    adapter: mcp-http",
  "    url: https://example.invalid/mcp",
  "    headers:",
  "      accessKey: ${GANGTISE_ACCESS_KEY}",
  "      secretKey: ${GANGTISE_SECRET_KEY}",
  "      literal: literal-value",
  "      fromProcessEnv: ${INHERITED_FROM_PROCESS_ENV}",
  "transport:",
  "  type: http",
  "  port: 31999",
  "naming:",
  "  auto_unwrap_single_service: true",
  "",
].join("\n"));

test("top-level env_file: ${VAR} expands to file value, inline env overrides", () => {
  const box = loadBoxConfig(boxPath);
  // GANGTISE_SECRET_KEY is only in env_file, not overridden by inline env.
  assert.equal(
    box.config.services.upstream.headers.secretKey,
    "sk-from-file",
  );
  // GANGTISE_ACCESS_KEY is in BOTH env_file and inline env. Inline wins.
  assert.equal(
    box.config.services.upstream.headers.accessKey,
    "ak-from-inline-override",
  );
});

test("top-level env: literal value passes through without expansion", () => {
  const box = loadBoxConfig(boxPath);
  assert.equal(box.config.services.upstream.headers.literal, "literal-value");
});

test("expand context falls back to process.env for undeclared VARs", () => {
  const box = loadBoxConfig(boxPath);
  assert.equal(
    box.config.services.upstream.headers.fromProcessEnv,
    "from-process-env",
  );
});

// Cleanup the temp dir once the file is done.
test.after(() => rmSync(tmp, { recursive: true, force: true }));
