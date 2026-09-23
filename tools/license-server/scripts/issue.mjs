#!/usr/bin/env node
// Issue a license key via a running license server: POST /v1/issue.
//   node scripts/issue.mjs --email buyer@example.com [--seats N] [--entitlements a,b] [--versions 1.x] [--url http://host:port]
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!flag.startsWith('--') || i + 1 >= argv.length) {
      console.error(`usage: node scripts/issue.mjs --email buyer@example.com [--seats N] [--entitlements a,b] [--versions 1.x] [--url http://host:port]`);
      process.exit(2);
    }
    args[flag.slice(2)] = argv[i + 1];
  }
  return args;
}

function defaultUrl() {
  const configFile = join(ROOT, 'config.json');
  const fallback = 'http://127.0.0.1:8787';
  if (!existsSync(configFile)) return fallback;
  try {
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    return `http://${config.host ?? '127.0.0.1'}:${config.port ?? 8787}`;
  } catch {
    return fallback;
  }
}

const args = parseArgs(process.argv.slice(2));
if (!args.email) {
  console.error('error: --email is required');
  process.exit(2);
}

const list = (value) => (value ? value.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const body = {
  customerEmail: args.email,
  seats: args.seats ? Number(args.seats) : undefined,
  entitlements: list(args.entitlements),
  versions: list(args.versions),
};
for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];

const url = `${(args.url ?? defaultUrl()).replace(/\/$/, '')}/v1/issue`;
try {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  console.log(JSON.stringify(json, null, 2));
  if (!json.ok) process.exit(1);
  console.error('\nThis license key is shown ONCE. Store it securely; it cannot be retrieved again.');
} catch (err) {
  console.error(`error: request to ${url} failed: ${err.message}`);
  process.exit(1);
}
