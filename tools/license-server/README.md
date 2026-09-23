# Catalyst reference license server

A complete, runnable reference implementation of a Catalyst plugin license server.
Third-party plugin vendors copy this directory and adapt it — it is example tooling,
not a hosted service. Plain `node server.mjs` on Node 20+, **zero npm dependencies**
(Node builtins only).

## 1. What this is

- Issues license keys (`POST /v1/issue`) and stores them **hashed** (`sha256` hex).
- Activates installs (`POST /v1/activate`): checks key/revocation/version/seats, then
  returns the master DEK wrapped with a KEK derived from the license key and install id.
  The panel plugin derives the same KEK and unwraps the DEK locally.
- Deactivates installs (`POST /v1/deactivate`) and revokes keys (`POST /v1/revoke`).
- Persists to a single JSON file (`licenses.json`) with atomic writes.

```
tools/license-server/
  server.mjs            router + handlers
  lib/keys.mjs          keygen + hashing
  lib/store.mjs         JSON file store, atomic writes
  lib/wrap.mjs          HKDF + AES-256-GCM wrap/unwrap helpers
  scripts/issue.mjs     CLI over POST /v1/issue
  config.example.json
  README.md
```

## 2. Quick start

```sh
# 1. Generate the master DEK (32 raw bytes) and configure
openssl rand -base64 32          # put the output into "masterDek"
cp config.example.json config.json
$EDITOR config.json              # set "masterDek" (required — the server refuses to start without it)

# 2. Start the server (default 127.0.0.1:8787; PORT/HOST env vars override)
node server.mjs

# 3. Issue a license (shown ONCE, never retrievable again)
node scripts/issue.mjs --email buyer@example.com --seats 1 \
  --entitlements bzip2,multi-node --versions 1.x
# → { "ok": true, "licenseKey": "VND1-K4M2Q-8XR7P-3TN9W-B5HD2", ... }

# 4. Activate an install
curl -s http://127.0.0.1:8787/v1/activate -d '{
  "licenseKey": "VND1-K4M2Q-8XR7P-3TN9W-B5HD2",
  "installId": "inst_4f8a1c2e9b03d6a75c1e8f20",
  "pluginName": "licensed-example",
  "pluginVersion": "1.0.0"
}'
```

Response `200`:

```json
{
  "ok": true,
  "wrappedDek": "<base64url of nonce(12) || ciphertext || tag(16)>",
  "expiresAt": "2026-09-29T12:00:00.000Z",
  "entitlements": ["bzip2", "multi-node"],
  "seats": { "used": 1, "max": 1 }
}
```

Errors are `{"ok":false,"code":"..."}` with:

| Status | Code | Meaning |
|---|---|---|
| 401 | `INVALID_KEY` | key unknown or hash mismatch |
| 403 | `REVOKED` | key explicitly revoked |
| 409 | `SEAT_EXHAUSTED` | installId not bound and no free seat |
| 409 | `VERSION_MISMATCH` | key not entitled for this `pluginVersion` |
| 400 | `BAD_REQUEST` | missing/invalid fields |
| 413 | `PAYLOAD_TOO_LARGE` | body over 16 KB |
| 503 | `UNAVAILABLE` | transient (storage) failure |
| 500 | `INTERNAL` | unexpected — never a stack trace |
| 404 | `NOT_FOUND` | unknown route |

Other endpoints: `POST /v1/deactivate` `{"licenseKey","installId"}` (frees the seat),
`POST /v1/revoke` `{"licenseKey","reason"}` (vendor admin), `GET /healthz`.

## 3. Crypto contract (reimplementable in any language)

KEK derivation, identical on server and panel plugin:

```
KEK = HKDF-SHA256(
        ikm  = UTF-8(licenseKey),
        salt = UTF-8(installId),
        info = UTF-8("catalyst-catpkg-dek-wrap-v1"),
        len  = 32)
```

In Node: `crypto.hkdfSync('sha256', ikm, salt, info, 32)`.

Wrap: **AES-256-GCM**, key = `KEK`, plaintext = the master DEK (32 raw bytes).
`AAD = UTF-8(pluginName + "\u0000" + pluginVersion)`.
Output = `nonce(12 random bytes) || ciphertext || tag(16)`, then **base64url** —
60 raw bytes, 80 base64url chars. Unwrap reverses it and verifies the GCM tag.

License key format: `VND1-` + 4 groups of 5 Crockford base32 chars
(alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` — no I, L, O, U) = 20 payload chars
≈ 100 bits of entropy from `crypto.randomBytes`. The prefix is configurable
(`keyPrefix`). Keys are stored only as `sha256` hex of the full key string;
lookups use `crypto.timingSafeEqual`. A leaked data file leaks no usable keys.

## 4. Outgrowing this reference

- **Per-customer DEK wrapping** — wrap the master DEK per customer (KEK derived from
  the customer's root secret) instead of returning the shared one, so one leaked
  wrapped blob does not unlock every install of every customer.
- **Postgres instead of the JSON file** — swap `lib/store.mjs`; add a unique index on
  the key hash and keep the same record shape. Needed once you have concurrent writes.
- **JWT-signed entitlement tokens** — for non-encrypted feature gating, sign
  `{sub, entitlements, exp}` with an asymmetric key so features can be checked offline
  without a wrapped DEK at all.
- **A real payments connector** — wire `POST /v1/issue` to your billing webhooks
  (Stripe, Paddle, …); keep issuance idempotent by keying on the payment id.

## 5. Security notes

- Keys are stored **hashed** (`sha256`), compared with **constant-time** equality.
- The raw license key never appears in logs — only the first 12 hex chars of its hash.
- **TLS is required in production.** The panel refuses plain `http` endpoints except
  for `127.0.0.1`/`localhost`; front this server with a reverse proxy that terminates TLS.
- **Rate limiting is the operator's job** — put it on that reverse proxy. This
  reference deliberately has none.
- Request bodies are capped at 16 KB; responses never leak stack traces.
- Keep `config.json` (it holds `masterDek`) and `licenses.json` out of version control.
