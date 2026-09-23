#!/usr/bin/env node
/**
 * Build the licensed-example plugin — `npm run build`, one command, three steps:
 *
 *  1. Bundle payload-src/index.ts -> dist/payload.mjs. One self-contained ESM
 *     file with everything inlined (the payload is imported from a `data:` URL
 *     at runtime, so it may have no bare imports).
 *  2. Run scripts/encrypt.mjs: generate a fresh 32-byte DEK, seal the payload
 *     with AES-256-GCM (AAD = licensingAad(name, version)) as
 *     backend/payload.enc = nonce(12) || ciphertext || tag(16), and print the
 *     DEK for your license server (dist/dek.base64url — secret!).
 *  3. Bundle src/bootstrap.ts -> backend/index.js. Plain importable ESM with
 *     @catalyst/plugin-sdk/licensing INLINED — the panel has no such package
 *     at runtime, so a bare import would fail at load.
 *
 * Tool resolution: node_modules/.bin/esbuild in this plugin directory or at
 * the repo root (whichever has it installed), else `npx esbuild`. The SDK's
 * licensing module is resolved from node_modules when installed, else from a
 * monorepo checkout of the SDK (packages/plugin-sdk/dist/licensing.js) so
 * this example also builds in-tree.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(root, '..');

function findEsbuild() {
  const bin = process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild';
  for (const dir of [root, repoRoot]) {
    const candidate = join(dir, 'node_modules', '.bin', bin);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function findSdkLicensing() {
  for (const from of [root, repoRoot]) {
    try {
      return createRequire(join(from, 'package.json')).resolve('@catalyst/plugin-sdk/licensing');
    } catch {
      // not installed from here — try the checkouts below
    }
  }
  for (const candidate of [
    join(repoRoot, 'packages', 'plugin-sdk', 'dist', 'licensing.js'),
    join(repoRoot, '..', 'catalyst', 'packages', 'plugin-sdk', 'dist', 'licensing.js'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const esbuild = findEsbuild();
const sdk = findSdkLicensing();
if (!sdk) {
  console.error('cannot resolve @catalyst/plugin-sdk/licensing — npm install @catalyst/plugin-sdk,');
  console.error('or run this from a checkout that contains packages/plugin-sdk/dist/licensing.js');
  process.exit(1);
}

function run(label, args) {
  console.log(`==> ${label}`);
  const cmd = esbuild ?? 'npx';
  const full = esbuild ? args : ['esbuild', ...args];
  const res = spawnSync(cmd, full, { cwd: root, stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`step failed: ${label}`);
    process.exit(res.status ?? 1);
  }
}

mkdirSync(join(root, 'backend'), { recursive: true });
mkdirSync(join(root, 'dist'), { recursive: true });

const sdkAlias = `--alias:@catalyst/plugin-sdk/licensing=${sdk}`;

// 1. Payload source -> dist/payload.mjs (single ESM, everything inlined)
run('bundle payload-src/index.ts -> dist/payload.mjs', [
  '--bundle',
  '--format=esm',
  '--platform=node',
  sdkAlias,
  '--outfile=dist/payload.mjs',
  'payload-src/index.ts',
]);

// 2. Seal it with a fresh DEK -> backend/payload.enc
console.log('==> encrypt dist/payload.mjs -> backend/payload.enc');
const enc = spawnSync(process.execPath, [join(root, 'scripts', 'encrypt.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
if (enc.status !== 0) {
  console.error('step failed: scripts/encrypt.mjs');
  process.exit(enc.status ?? 1);
}

// 3. Bootstrap -> backend/index.js (SDK inlined; output is plain ESM JS)
run('bundle src/bootstrap.ts -> backend/index.js', [
  '--bundle',
  '--format=esm',
  '--platform=node',
  sdkAlias,
  '--outfile=backend/index.js',
  'src/bootstrap.ts',
]);

console.log('build complete: backend/index.js + backend/payload.enc (commit these two)');
