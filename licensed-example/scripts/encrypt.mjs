#!/usr/bin/env node
/**
 * Step 2 of the build: seal dist/payload.mjs into backend/payload.enc.
 *
 *   backend/payload.enc = nonce(12) || AES-256-GCM(ciphertext) || tag(16)
 *   AAD = UTF-8(pluginName + "\0" + pluginVersion)   (= `licensingAad` in
 *         @catalyst/plugin-sdk/licensing — replicated here so the build
 *         step stays dependency-free)
 *
 * A FRESH 32-byte DEK is generated on every build. The DEK is what your
 * license server hands out to customers *wrapped* (AES-256-GCM under a KEK
 * derived from their license key + install id) — it must never be committed,
 * shipped in the catpkg, or sent over the wire in the clear.
 */
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));

// Must byte-match `licensingAad(name, version)` — the runtime unwrap fails otherwise.
const aad = Buffer.from(`${manifest.name}\u0000${manifest.version}`, 'utf8');

const plaintext = readFileSync(join(root, 'dist', 'payload.mjs'));
const dek = randomBytes(32);
const nonce = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', dek, nonce);
cipher.setAAD(aad);
const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const tag = cipher.getAuthTag(); // 16 bytes
const envelope = Buffer.concat([nonce, ciphertext, tag]);

mkdirSync(join(root, 'backend'), { recursive: true });
writeFileSync(join(root, 'backend', 'payload.enc'), envelope);

const dekB64Url = dek.toString('base64url');
writeFileSync(join(root, 'dist', 'dek.base64url'), `${dekB64Url}\n`);

console.log(`sealed dist/payload.mjs -> backend/payload.enc (${envelope.length} = 12 + ${plaintext.length} + 16 bytes)`);
console.log('');
console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
console.log('!! MASTER DEK (base64url) — also written to dist/dek.base64url');
console.log(`!!   ${dekB64Url}`);
console.log('!! Paste this into your license server\'s config.json as "masterDek".');
console.log('!! NEVER commit it. NEVER ship it. NEVER paste it into a ticket.');
console.log('!! dist/ is gitignored for exactly this reason — treat it as a secret.');
console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
