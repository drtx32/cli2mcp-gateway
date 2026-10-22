import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const FORMAT_VERSION = 1;

function fail(path, message, cause) {
  const error = new Error(`OAuth client store ${path}: ${message}`, { cause });
  error.code = "OAUTH_CLIENT_STORE_ERROR";
  return error;
}

function validClient(client) {
  return client && typeof client.clientId === "string" && client.clientId.startsWith("client_")
    && typeof client.clientName === "string" && Array.isArray(client.redirectUris)
    && client.redirectUris.length > 0 && client.redirectUris.every(uri => typeof uri === "string")
    && Number.isSafeInteger(client.issuedAt) && client.issuedAt > 0;
}

function readStore(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("expected a regular, non-symlink file");
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (data?.formatVersion !== FORMAT_VERSION || !Array.isArray(data.clients)
        || !data.clients.every(validClient)
        || new Set(data.clients.map(client => client.clientId)).size !== data.clients.length) {
      throw new Error("unsupported or invalid data format");
    }
    return data.clients;
  } catch (error) {
    throw fail(path, "cannot read valid data", error);
  }
}

function writeStore(path, clients) {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify({ formatVersion: FORMAT_VERSION, clients }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tempPath, path);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* best effort cleanup */ }
    throw fail(path, "cannot write data", error);
  }
}

/** Load and maintain an optional local-only dynamic client registry. */
export function openOAuthClientStore(filePath, { maxAgeDays = 3650, now = Date.now() } = {}) {
  if (!filePath) return null;
  const path = resolve(filePath);
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    throw fail(path, "OAUTH_CLIENT_MAX_AGE_DAYS must be a positive number");
  }

  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) writeStore(path, []);
    const clients = readStore(path);
    chmodSync(path, 0o600);
    const maxAgeMs = maxAgeDays * 86400_000;
    const active = clients.filter(client => client.issuedAt <= now && now - client.issuedAt < maxAgeMs);
    if (active.length !== clients.length) writeStore(path, active);
    return {
      clients: new Map(active.map(({ clientId, clientName, redirectUris }) => [clientId, { clientName, redirectUris } ])),
      save(clientId, { clientName, redirectUris }, issuedAt = Date.now()) {
        const next = [...active.filter(client => client.clientId !== clientId), { clientId, clientName, redirectUris, issuedAt }];
        writeStore(path, next);
        active.splice(0, active.length, ...next);
      },
    };
  } catch (error) {
    if (error?.code === "OAUTH_CLIENT_STORE_ERROR") throw error;
    throw fail(path, "cannot initialize", error);
  }
}
