/**
 * Minimal OpenID Connect helpers for the oidc-sso plugin.
 *
 * Only Node built-ins (fetch + node:crypto) — the plugin ships with no npm
 * dependencies, so JWT verification is implemented directly:
 *  - discovery via /.well-known/openid-configuration (or explicit override)
 *  - authorization_code exchange (client_secret_basic with post fallback)
 *  - ID-token signature check against the provider JWKS (RS/ES families)
 *  - userinfo fetch
 */

import { createHash, createPublicKey, createVerify } from 'node:crypto';

export class OidcError extends Error {
  constructor(message, { status = 0, body = null, code = 'oidc_failed' } = {}) {
    super(message);
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

const FETCH_TIMEOUT_MS = 12_000;

async function fetchJson(url, { method = 'GET', headers = {}, form = null, json = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    const init = { method, headers: { ...headers }, signal: controller.signal };
    if (form) {
      init.body = new URLSearchParams(form).toString();
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    res = await fetch(url, init);
  } catch (err) {
    clearTimeout(timer);
    throw new OidcError(`Request to ${safeHost(url)} failed: ${err.message}`, { code: 'network_failed' });
  }
  clearTimeout(timer);

  const text = await res.text().catch(() => '');
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const message =
      (data && typeof data === 'object' && (data.error_description || data.error)) ||
      `Provider returned HTTP ${res.status}`;
    throw new OidcError(String(message), { status: res.status, body: data, code: 'provider_error' });
  }
  if (json && data !== null && typeof data !== 'object') {
    throw new OidcError(`Expected JSON from ${safeHost(url)}`, { code: 'bad_response' });
  }
  return data;
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'provider';
  }
}

/** Discovery document URL for a provider (explicit override wins). */
export function discoveryUrlFor(provider) {
  const override = String(provider.discoveryUrl || '').trim();
  if (override) return override;
  const issuer = String(provider.issuer || '').trim().replace(/\/+$/, '');
  if (!issuer) throw new OidcError('Provider issuer is not configured', { code: 'not_configured' });
  return `${issuer}/.well-known/openid-configuration`;
}

export async function fetchDiscovery(provider) {
  const url = discoveryUrlFor(provider);
  const doc = await fetchJson(url, { json: true });
  if (!doc || typeof doc !== 'object' || !doc.authorization_endpoint || !doc.token_endpoint) {
    throw new OidcError('Discovery document is missing authorization/token endpoints', { code: 'bad_discovery' });
  }
  return doc;
}

export async function fetchJwks(jwksUri) {
  const doc = await fetchJson(jwksUri, { json: true });
  const keys = doc && Array.isArray(doc.keys) ? doc.keys : null;
  if (!keys) throw new OidcError('JWKS document has no keys array', { code: 'bad_jwks' });
  return { keys };
}

// ── JWT ────────────────────────────────────────────────────────────────

function b64urlToBuf(input) {
  return Buffer.from(String(input).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function parseJwt(token) {
  if (typeof token !== 'string' || token.split('.').length !== 3) {
    throw new OidcError('ID token is malformed', { code: 'bad_id_token' });
  }
  const [hB64, pB64, sB64] = token.split('.');
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(hB64, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(pB64, 'base64url').toString('utf8'));
  } catch {
    throw new OidcError('ID token is not valid JSON', { code: 'bad_id_token' });
  }
  return {
    header,
    payload,
    signingInput: `${hB64}.${pB64}`,
    signature: b64urlToBuf(sB64),
  };
}

const VERIFY_ALGOS = {
  RS256: 'RSA-SHA256',
  RS384: 'RSA-SHA384',
  RS512: 'RSA-SHA512',
  ES256: 'SHA256',
  ES384: 'SHA384',
  ES512: 'SHA512',
};

function publicKeyFromJwk(jwk) {
  // Node >= 16 supports JWK import for RSA/EC keys directly.
  return createPublicKey({ key: jwk, format: 'jwk' });
}

/**
 * Verify an ID token's signature + core claims.
 * Returns the payload on success; throws OidcError otherwise.
 */
export function verifyIdToken(idToken, { jwks, clientId, issuer, nonce = null, clockSkewSec = 60 }) {
  const { header, payload, signingInput, signature } = parseJwt(idToken);
  const alg = String(header.alg || '');
  const nodeAlg = VERIFY_ALGOS[alg];
  if (!nodeAlg) {
    throw new OidcError(`Unsupported ID-token signing algorithm "${alg || 'none'}"`, { code: 'bad_id_token_alg' });
  }
  const kids = (jwks.keys || []).filter((k) => !header.kid || k.kid === header.kid);
  if (kids.length === 0) {
    throw new OidcError('No matching key found for ID token (kid mismatch)', { code: 'bad_kid' });
  }
  let verified = false;
  let lastErr = null;
  for (const jwk of kids) {
    try {
      const key = publicKeyFromJwk(jwk);
      const ok = createVerify(nodeAlg).update(signingInput).verify(key, signature);
      if (ok) {
        verified = true;
        break;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  if (!verified) {
    throw new OidcError(`ID-token signature check failed${lastErr ? `: ${lastErr.message}` : ''}`, {
      code: 'bad_signature',
    });
  }

  const now = Math.floor(Date.now() / 1000);
  if (issuer && payload.iss !== issuer && payload.iss !== String(issuer).replace(/\/+$/, '')) {
    // Discovery issuer is authoritative; tolerate a trailing-slash difference.
    throw new OidcError('ID-token issuer mismatch', { code: 'bad_issuer' });
  }
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(clientId)) {
    throw new OidcError('ID-token audience mismatch (client_id)', { code: 'bad_audience' });
  }
  if (typeof payload.exp === 'number' && now > payload.exp + clockSkewSec) {
    throw new OidcError('ID token is expired', { code: 'token_expired' });
  }
  if (typeof payload.iat === 'number' && payload.iat > now + clockSkewSec) {
    throw new OidcError('ID token was issued in the future', { code: 'bad_iat' });
  }
  if (nonce != null && payload.nonce !== nonce) {
    throw new OidcError('ID-token nonce mismatch', { code: 'bad_nonce' });
  }
  return payload;
}

// ── token exchange / userinfo ──────────────────────────────────────────

export async function exchangeCode({ tokenEndpoint, clientId, clientSecret, code, redirectUri, codeVerifier }) {
  const form = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
  };
  if (codeVerifier) form.code_verifier = codeVerifier;
  const headers = {};
  // RFC 6749 §2.3.1: confidential clients authenticate with HTTP Basic.
  // The secret also stays in the body for providers that only read the form.
  if (clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
    form.client_secret = clientSecret;
  }
  return fetchJson(tokenEndpoint, { method: 'POST', headers, form, json: true });
}

export async function fetchUserinfo(userinfoEndpoint, accessToken) {
  if (!userinfoEndpoint) return {};
  const data = await fetchJson(userinfoEndpoint, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  return data && typeof data === 'object' ? data : {};
}

// ── claims ─────────────────────────────────────────────────────────────

/** Read a dotted claim path (e.g. "realm_access.roles" is NOT traversed — use plain keys). */
export function claimAt(obj, path) {
  if (!obj || typeof path !== 'string' || !path) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];
  const parts = path.split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}
