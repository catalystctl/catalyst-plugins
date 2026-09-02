#!/usr/bin/env node
/**
 * Build runtime frontend bundles (frontend/frontend.mjs) for every plugin
 * that ships a vite.config.mts. These self-contained ESM bundles are what
 * marketplace-installed plugins serve under /plugins-assets/<name>/ —
 * required for the plugin UI to work without a panel rebuild (and in the
 * Docker deployment, where build-time frontends don't exist).
 *
 * Contract (docs/plugins.md): lib-mode ES bundle, everything inlined,
 * exporting the same shape as a build-time frontend module.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viteBin = path.join(repoRoot, 'node_modules', '.bin', 'vite');

if (!existsSync(viteBin)) {
  console.error('vite not found — run `pnpm install` in this repo first');
  process.exit(1);
}

let built = 0;
for (const name of readdirSync(repoRoot)) {
  const dir = path.join(repoRoot, name);
  if (!statSync(dir).isDirectory() || name.startsWith('.') || name === 'node_modules' || name === 'dist' || name === 'scripts') continue;
  const config = path.join(dir, 'vite.config.mts');
  if (!existsSync(config)) continue;

  console.log(`==> bundling frontend for ${name}`);
  const res = spawnSync(viteBin, ['build', '--config', config], { cwd: dir, stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`frontend bundle failed for ${name}`);
    process.exit(1);
  }
  const out = path.join(dir, 'dist', 'frontend.mjs');
  if (!existsSync(out)) {
    console.error(`expected ${out} after build`);
    process.exit(1);
  }
  // Ship the bundle inside frontend/ so the catpkg includes it and the panel
  // serves it from /plugins-assets/<name>/frontend.mjs.
  mkdirSync(path.join(dir, 'frontend'), { recursive: true });
  renameSync(out, path.join(dir, 'frontend', 'frontend.mjs'));
  rmSync(path.join(dir, 'dist'), { recursive: true, force: true });
  built++;
}

console.log(`built ${built} frontend bundle(s)`);
