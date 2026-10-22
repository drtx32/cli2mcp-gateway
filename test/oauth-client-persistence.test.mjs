import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}

async function startGateway(port, storePath) {
  const issuer = `https://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.mjs', 'serve', '--http'], {
    cwd: projectRoot,
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), PUBLIC_ENDPOINT: issuer,
      OAUTH_ISSUER: issuer, AUTH_MODE: 'oauth', OAUTH_USERNAME: 'test-user',
      OAUTH_PASSWORD: 'test-password', AUTH0_ISSUER: '', AUTH0_AUDIENCE: '', MCP_TOKEN: '',
      CLI_COMMAND: process.execPath, CLI_DUAL_TOOL_MODE: 'true', CLI_SUBCOMMANDS: '',
      CLI_CWD: projectRoot, OAUTH_CLIENT_STORE_PATH: storePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  child.stdout.on('data', () => {});
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Gateway exited (${child.exitCode}): ${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return child;
    } catch { /* wait for startup */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  child.kill('SIGTERM');
  throw new Error(`Gateway did not become ready: ${stderr}`);
}

async function stopGateway(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise(resolveExit => child.once('exit', resolveExit));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolveTimeout => setTimeout(resolveTimeout, 3000))]);
}

test('persisted OAuth client registration remains authorized after gateway restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cli2mcp-oauth-'));
  const storePath = join(directory, 'oauth-clients.json');
  const port = await unusedPort();
  let child;
  const redirectUri = 'http://127.0.0.1:4567/oauth/callback';
  try {
    child = await startGateway(port, storePath);
    const registration = await fetch(`http://127.0.0.1:${port}/oauth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'restart-test-client', redirect_uris: [redirectUri] }),
    });
    assert.equal(registration.status, 201);
    const registered = await registration.json();

    const originalStore = readFileSync(storePath, 'utf8');
    for (const clientName of [null, { unexpected: 'object' }]) {
      const malformed = await fetch(`http://127.0.0.1:${port}/oauth/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: clientName, redirect_uris: [redirectUri] }),
      });
      assert.equal(malformed.status, 400);
      assert.equal(readFileSync(storePath, 'utf8'), originalStore);
    }
    await stopGateway(child);

    assert.equal(statSync(storePath).mode & 0o777, 0o600);
    const disk = JSON.parse(readFileSync(storePath, 'utf8'));
    assert.equal(disk.formatVersion, 1);
    assert.equal(disk.clients.length, 1);
    assert.equal(disk.clients[0].clientId, registered.client_id);

    child = await startGateway(port, storePath);
    const authorize = new URL(`http://127.0.0.1:${port}/oauth/authorize`);
    authorize.searchParams.set('client_id', registered.client_id);
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('code_challenge', 'challenge');
    authorize.searchParams.set('code_challenge_method', 'S256');
    const valid = await fetch(authorize, { redirect: 'manual' });
    assert.equal(valid.status, 200);
    assert.match(await valid.text(), /restart-test-client/);

    authorize.searchParams.set('redirect_uri', 'http://127.0.0.1:4567/attacker');
    const invalidRedirect = await fetch(authorize, { redirect: 'manual' });
    assert.equal(invalidRedirect.status, 400);
  } finally {
    if (child) await stopGateway(child);
    rmSync(directory, { recursive: true, force: true });
  }
});
