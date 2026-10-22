import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListening, rejectListening) => {
    server.once('error', rejectListening);
    server.listen(0, '127.0.0.1', resolveListening);
  });
  const port = server.address().port;
  await new Promise(resolveClosed => server.close(resolveClosed));
  return port;
}

async function waitForGateway(port, child) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Gateway exited during startup (${child.exitCode})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch { /* gateway not listening yet */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error('Gateway did not become ready');
}

test('built-in OAuth discovery advertises the implemented authorization route', async () => {
  const port = await unusedPort();
  const issuer = `https://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.mjs', 'serve', '--http'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      PUBLIC_ENDPOINT: issuer,
      OAUTH_ISSUER: issuer,
      AUTH_MODE: 'oauth',
      OAUTH_USERNAME: 'test-user',
      OAUTH_PASSWORD: 'local-test-password',
      AUTH0_ISSUER: '',
      AUTH0_AUDIENCE: '',
      MCP_TOKEN: '',
      MCP_ALLOWED_IPS: '',
      ALLOWED_IPS: '',
      ALLOWED_HOSTS: '127.0.0.1,localhost',
      CLI_COMMAND: process.execPath,
      CLI_DUAL_TOOL_MODE: 'true',
      CLI_SUBCOMMANDS: '',
      CLI_CWD: projectRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  child.stdout.on('data', () => {});

  try {
    await waitForGateway(port, child);
    const metadataResponse = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`);
    assert.equal(metadataResponse.status, 200);
    const metadata = await metadataResponse.json();
    assert.equal(metadata.issuer, issuer);
    assert.equal(metadata.authorization_endpoint, `${issuer}/oauth/authorize`);
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);

    // The advertised route exists and rejects an incomplete authorization request.
    const authorizeResponse = await fetch(`http://127.0.0.1:${port}/oauth/authorize`);
    assert.equal(authorizeResponse.status, 400);
  } catch (error) {
    throw new Error(`${error.message}\nGateway stderr: ${stderr}`);
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise(resolveExit => child.once('exit', resolveExit));
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise(resolveTimeout => setTimeout(resolveTimeout, 3000))]);
    }
  }
});
