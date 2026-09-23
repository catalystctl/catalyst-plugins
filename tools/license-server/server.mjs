// Reference Catalyst license server. Plain `node server.mjs`, Node 20+, zero deps.
// Wire protocol: POST /v1/activate | /v1/deactivate | /v1/revoke | /v1/issue, GET /healthz.
import { createServer } from 'node:http';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateLicenseKey, hashEquals, hashLicenseKey, hashPrefix, isValidLicenseKey } from './lib/keys.mjs';
import { loadStore, saveStore } from './lib/store.mjs';
import { wrapDek } from './lib/wrap.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 16 * 1024;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const INSTALL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,127}$/;

function loadConfig() {
  const configFile = join(ROOT, 'config.json');
  if (!existsSync(configFile)) {
    copyFileSync(join(ROOT, 'config.example.json'), configFile);
    console.error(`Created ${configFile} from config.example.json.`);
  }
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  const dek = Buffer.from(String(config.masterDek ?? ''), 'base64'); // accepts base64url too
  if (dek.length !== 32) {
    console.error('FATAL: config.json "masterDek" is missing or empty.');
    console.error('Generate one with:  openssl rand -base64 32');
    console.error('Then set it as the value of "masterDek" in config.json and restart.');
    process.exit(1);
  }
  config.masterDekBytes = dek;
  const dataFile = config.dataFile ?? './licenses.json';
  config.dataFile = isAbsolute(dataFile) ? dataFile : resolve(ROOT, dataFile);
  config.port = Number(process.env.PORT ?? config.port ?? 8787);
  config.host = process.env.HOST ?? config.host ?? '127.0.0.1';
  return config;
}

const config = loadConfig();
let store;
try {
  store = loadStore(config.dataFile);
} catch (err) {
  console.error(`FATAL: cannot read data file ${config.dataFile}: ${err.message}`);
  process.exit(1);
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const fail = (status, code) => Object.assign(new Error(code), { status, code });
const must = (cond) => { if (!cond) throw fail(400, 'BAD_REQUEST'); };

// Storage failures are transient; anything else surfaces as 500 INTERNAL below.
function persist() {
  try {
    saveStore(config.dataFile, store);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EIO') throw fail(503, 'UNAVAILABLE');
    throw err;
  }
}

function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on('data', (chunk) => {
      if (overflow) return; // stop buffering; the 413 is already on its way
      size += chunk.length;
      if (size > MAX_BODY) {
        overflow = true;
        chunks.length = 0;
        rejectPromise(fail(413, 'PAYLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const body = text.length ? JSON.parse(text) : {};
        must(body && typeof body === 'object' && !Array.isArray(body));
        resolvePromise(body);
      } catch {
        rejectPromise(fail(400, 'BAD_REQUEST'));
      }
    });
    req.on('error', () => rejectPromise(fail(400, 'BAD_REQUEST')));
  });
}

// Constant-time lookup: hash the presented key, compare against every stored hash.
function findLicense(licenseKey) {
  const presented = hashLicenseKey(licenseKey);
  for (const [storedHash, entry] of Object.entries(store.keys)) {
    if (hashEquals(presented, storedHash)) return entry;
  }
  return null;
}

function requireEntry(body, allowRevoked = false) {
  must(isValidLicenseKey(body.licenseKey, config.keyPrefix));
  const entry = findLicense(body.licenseKey);
  if (!entry) throw fail(401, 'INVALID_KEY');
  if (entry.revoked && !allowRevoked) throw fail(403, 'REVOKED');
  return entry;
}

// "1.x" / "1" matches major, "1.2.x" matches major.minor, "1.2.3" is an exact match.
function versionMatches(pattern, version) {
  const want = String(pattern).split('.');
  const got = version.split('.');
  return want.length <= 3 && want.every((part, i) => part === 'x' || part === '*' || part === got[i]);
}

function activate(body) {
  must(typeof body.installId === 'string' && INSTALL_ID_RE.test(body.installId)
    && typeof body.pluginName === 'string' && body.pluginName.length > 0 && body.pluginName.length <= 100
    && typeof body.pluginVersion === 'string' && VERSION_RE.test(body.pluginVersion));
  const entry = requireEntry(body);
  if (!(entry.versions ?? []).some((p) => versionMatches(p, body.pluginVersion))) throw fail(409, 'VERSION_MISMATCH');
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + config.defaultTtlHours * 3600_000).toISOString();
  const existing = entry.bound.find((b) => b.installId === body.installId);
  if (existing) {
    existing.activatedAt = now;
    existing.expiresAt = expiresAt;
  } else if (entry.bound.length < entry.seats) {
    entry.bound.push({ installId: body.installId, activatedAt: now, expiresAt });
  } else {
    throw fail(409, 'SEAT_EXHAUSTED');
  }
  persist();
  return {
    ok: true,
    wrappedDek: wrapDek(body.licenseKey, body.installId, body.pluginName, body.pluginVersion, config.masterDekBytes),
    expiresAt,
    entitlements: entry.entitlements ?? [],
    seats: { used: entry.bound.length, max: entry.seats },
  };
}

function deactivate(body) {
  must(typeof body.installId === 'string' && INSTALL_ID_RE.test(body.installId));
  const entry = requireEntry(body);
  entry.bound = entry.bound.filter((b) => b.installId !== body.installId);
  persist();
  return { ok: true };
}

function revoke(body) {
  must(typeof body.reason === 'string' && body.reason.length > 0 && body.reason.length <= 500);
  const entry = requireEntry(body, true); // idempotent on an already-revoked key
  entry.revoked = true;
  entry.revokedReason = body.reason;
  persist();
  return { ok: true };
}

function issue(body) {
  const email = body.customerEmail;
  const seats = body.seats ?? 1;
  const entitlements = body.entitlements ?? [];
  const versions = body.versions ?? ['1.x'];
  must(typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254
    && Number.isInteger(seats) && seats >= 1
    && Array.isArray(entitlements) && entitlements.every((e) => typeof e === 'string')
    && Array.isArray(versions) && versions.length > 0 && versions.every((v) => typeof v === 'string'));
  // The plaintext key is returned once and never stored — only its sha256.
  let licenseKey = generateLicenseKey(config.keyPrefix);
  let hash = hashLicenseKey(licenseKey);
  while (store.keys[hash]) {
    licenseKey = generateLicenseKey(config.keyPrefix);
    hash = hashLicenseKey(licenseKey);
  }
  store.keys[hash] = { customerEmail: email, seats, bound: [], entitlements, versions, revoked: false, createdAt: new Date().toISOString() };
  persist();
  return { ok: true, licenseKey, customerEmail: email, seats };
}

const routes = new Map([
  ['POST /v1/activate', activate],
  ['POST /v1/deactivate', deactivate],
  ['POST /v1/revoke', revoke],
  ['POST /v1/issue', issue],
]);

async function handle(req, res) {
  const path = (req.url ?? '/').split('?')[0];
  const log = { ts: new Date().toISOString(), method: req.method, path, status: 200, outcome: 'ok' };
  try {
    if (req.method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true, vendorId: config.vendorId });
    } else {
      const handler = routes.get(`${req.method} ${path}`);
      if (!handler) throw fail(404, 'NOT_FOUND');
      const body = await readBody(req);
      // Never log the raw licenseKey — only a 12-hex-char hash prefix.
      Object.assign(log, {
        keyHash: typeof body.licenseKey === 'string' ? hashPrefix(body.licenseKey) : null,
        installId: body.installId ?? null,
        pluginName: body.pluginName ?? null,
        pluginVersion: body.pluginVersion ?? null,
      });
      sendJson(res, 200, handler(body));
    }
  } catch (err) {
    log.status = err.status ?? 500;
    log.outcome = err.status ? err.code : 'INTERNAL';
    // Oversized bodies are not consumed further: close the connection after replying.
    sendJson(res, log.status, { ok: false, code: log.outcome }, log.status === 413 ? { Connection: 'close' } : {});
  }
  console.log(JSON.stringify(log));
}

createServer((req, res) => {
  handle(req, res).catch(() => {
    if (!res.headersSent) sendJson(res, 500, { ok: false, code: 'INTERNAL' });
  });
}).listen(config.port, config.host, () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg: 'listening', vendorId: config.vendorId, host: config.host, port: config.port }));
});
