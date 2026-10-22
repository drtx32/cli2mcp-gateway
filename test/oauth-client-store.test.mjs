import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOAuthClientStore } from '../src/oauth-client-store.mjs';

test('OAuth client store removes expired registrations and rejects corrupt files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'oauth-store-'));
  const storePath = join(directory, 'clients.json');
  try {
    writeFileSync(storePath, JSON.stringify({
      formatVersion: 1,
      clients: [{
        clientId: 'client_expired', clientName: 'expired',
        redirectUris: ['https://client.example/callback'], issuedAt: 1,
      }],
    }));
    const store = openOAuthClientStore(storePath, { maxAgeDays: 1, now: 2 * 86400_000 });
    assert.equal(store.clients.size, 0);
    assert.deepEqual(JSON.parse(readFileSync(storePath, 'utf8')).clients, []);

    writeFileSync(storePath, '{broken');
    assert.throws(() => openOAuthClientStore(storePath), /cannot read valid data/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('OAuth client store fails initialization when its parent path is not a directory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'oauth-store-'));
  const parentFile = join(directory, 'not-a-directory');
  writeFileSync(parentFile, '');
  try {
    assert.throws(() => openOAuthClientStore(join(parentFile, 'clients.json')), /cannot initialize/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('OAuth client store restricts existing file permissions before loading it', { skip: process.platform === 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'oauth-store-'));
  const storePath = join(directory, 'clients.json');
  try {
    writeFileSync(storePath, JSON.stringify({ formatVersion: 1, clients: [] }), { mode: 0o666 });
    chmodSync(storePath, 0o644);
    openOAuthClientStore(storePath);
    assert.equal(statSync(storePath).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('OAuth client store rejects malformed client names without changing persisted data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'oauth-store-'));
  const storePath = join(directory, 'clients.json');
  try {
    const store = openOAuthClientStore(storePath);
    const original = readFileSync(storePath, 'utf8');
    assert.throws(() => store.save('client_test', { clientName: { invalid: true }, redirectUris: ['https://client.example/callback'] }), /Invalid OAuth client registration/);
    assert.throws(() => store.save('client_test', { clientName: 'x'.repeat(129), redirectUris: ['https://client.example/callback'] }), /Invalid OAuth client registration/);
    assert.equal(readFileSync(storePath, 'utf8'), original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
