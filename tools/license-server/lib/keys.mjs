// License key generation and hashing. Keys are stored hashed, never in the clear.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Crockford base32: 32 symbols, no I, L, O, U. A byte & 31 maps onto it uniformly.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const GROUPS = 4;
const GROUP_LEN = 5;

export function generateLicenseKey(prefix = 'VND1') {
  const total = GROUPS * GROUP_LEN; // 20 chars ~= 100 bits
  const bytes = randomBytes(total);
  let payload = '';
  for (let i = 0; i < total; i++) payload += ALPHABET[bytes[i] & 31];
  const groups = payload.match(new RegExp(`.{${GROUP_LEN}}`, 'g'));
  return `${prefix}-${groups.join('-')}`;
}

export function isValidLicenseKey(key, prefix = 'VND1') {
  if (typeof key !== 'string') return false;
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc}(-[0-9A-HJKMNP-TV-Z]{5}){4}$`).test(key);
}

// sha256 hex of the full key string; the map key in licenses.json.
export function hashLicenseKey(licenseKey) {
  return createHash('sha256').update(licenseKey, 'utf8').digest('hex');
}

// Log-safe fingerprint: first 12 hex chars of the hash. Never the raw key.
export function hashPrefix(licenseKey, n = 12) {
  return hashLicenseKey(licenseKey).slice(0, n);
}

// Constant-time hex digest comparison for lookups.
export function hashEquals(aHex, bHex) {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
