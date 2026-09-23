// DEK wrapping: HKDF-SHA256 -> AES-256-GCM. The panel plugin derives the same KEK
// the same way, so the wire format below is the interoperability contract.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const INFO = 'catalyst-catpkg-dek-wrap-v1';
const NONCE_LEN = 12;
const TAG_LEN = 16;
const DEK_LEN = 32;

// KEK = HKDF-SHA256(ikm=UTF-8(licenseKey), salt=UTF-8(installId),
//                   info=UTF-8("catalyst-catpkg-dek-wrap-v1"), len=32)
export function deriveKek(licenseKey, installId) {
  const ikm = Buffer.from(licenseKey, 'utf8');
  const salt = Buffer.from(installId, 'utf8');
  const info = Buffer.from(INFO, 'utf8');
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, DEK_LEN));
}

function aad(pluginName, pluginVersion) {
  return Buffer.from(`${pluginName}\u0000${pluginVersion}`, 'utf8');
}

// Wrap: AES-256-GCM, key=KEK, plaintext=DEK (32 raw bytes),
// AAD=UTF-8(pluginName + "\0" + pluginVersion).
// Output = nonce(12) || ciphertext || tag(16), base64url-encoded (80 chars).
export function wrapDek(licenseKey, installId, pluginName, pluginVersion, dek) {
  if (!Buffer.isBuffer(dek) || dek.length !== DEK_LEN) throw new Error('dek must be 32 raw bytes');
  const kek = deriveKek(licenseKey, installId);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', kek, nonce);
  cipher.setAAD(aad(pluginName, pluginVersion));
  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, tag]).toString('base64url');
}

// Unwrap: inverse of wrapDek. Throws on tamper, wrong key/installId, or bad shape.
export function unwrapDek(licenseKey, installId, pluginName, pluginVersion, wrappedDek) {
  const raw = Buffer.from(wrappedDek, 'base64url');
  if (raw.length !== NONCE_LEN + DEK_LEN + TAG_LEN) throw new Error('bad wrappedDek length');
  const nonce = raw.subarray(0, NONCE_LEN);
  const ciphertext = raw.subarray(NONCE_LEN, raw.length - TAG_LEN);
  const tag = raw.subarray(raw.length - TAG_LEN);
  const kek = deriveKek(licenseKey, installId);
  const decipher = createDecipheriv('aes-256-gcm', kek, nonce);
  decipher.setAAD(aad(pluginName, pluginVersion));
  decipher.setAuthTag(tag);
  const dek = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (dek.length !== DEK_LEN) throw new Error('bad dek length');
  return dek;
}
