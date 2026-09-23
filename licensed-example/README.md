# licensed-example — vendor licensing reference client

This is the **reference client** for Catalyst's vendor-owned license scheme:
a plugin whose valuable code is encrypted at rest in the package, decrypted at
runtime only after the plugin has activated a license key **against a license
server you own**. Third-party vendors copy this directory and adapt it.

What it demonstrates end to end:

- a plaintext **bootstrap** (`backend/index.js`, ~50 lines) that does nothing
  but activate the license, decrypt the payload, and forward lifecycle hooks;
- an **encrypted payload** (`backend/payload.enc`) containing the real plugin
  (a `/premium-report` route), sealed with AES-256-GCM under a per-version
  **DEK** that never ships in the package;
- **vendor-owned validation**: Catalyst issues no keys and validates none. Your
  license server wraps the DEK under a **KEK** derived from the customer's
  license key + the panel's `installId`; the plugin unwraps it locally;
- a thin, unencrypted **frontend tab** that calls the premium route.

The wire format (`KEK = HKDF-SHA256(licenseKey, installId, "catalyst-catpkg-dek-wrap-v1")`,
`wrap = AES-256-GCM(KEK, DEK)` with `AAD = UTF-8(name + "\0" + version)`,
payload envelope `nonce(12) || ciphertext || tag(16)`) is documented in
`@catalyst/plugin-sdk/licensing` and reimplemented in
`tools/license-server/lib/wrap.mjs` — reimplement it in any language.

## 1. Generate a DEK and run the reference license server

The DEK is a random 32-byte content key **per plugin version**. Your build
generates it (step 2 below) and prints it; your license server holds it and
hands it out *wrapped*, never in the clear.

```sh
cd tools/license-server
cp config.example.json config.json
# set "masterDek" to the DEK printed by the build (base64url) — or generate one
# first with `openssl rand -base64 32` if you are setting up the server before
# the first build, then rebuild the payload against that DEK workflow of yours.
node server.mjs                      # 127.0.0.1:8787
```

The reference server is plain Node (zero deps) and stores keys hashed. It
implements `POST /v1/issue`, `POST /v1/activate`, `POST /v1/deactivate`,
`POST /v1/revoke` and `GET /healthz`. It refuses to start without `masterDek`.

## 2. Issue a key

```sh
node tools/license-server/scripts/issue.mjs --email buyer@example.com \
  --seats 1 --entitlements bzip2,multi-node --versions 1.x
# → { "ok": true, "licenseKey": "VND1-...", "seats": 1 }
```

The plaintext key is shown **once** and stored only as a sha256 hash.

## 3. Build and pack

```sh
npm run build                 # from this directory
npx catalyst-plugin pack      # → licensed-example-1.0.0.catpkg.zip
```

`npm run build` runs `scripts/build.mjs`, which does three steps:

1. **Bundle the payload** — `payload-src/index.ts` → `dist/payload.mjs`, a
   single self-contained ESM file with everything inlined (it is imported from
   a `data:` URL at runtime, so it must have no bare imports).
2. **Encrypt the payload** — `scripts/encrypt.mjs` generates a fresh 32-byte
   DEK (`crypto.randomBytes(32)`), seals `dist/payload.mjs` with AES-256-GCM
   using `licensingAad(name, version)` as AAD, and writes
   `backend/payload.enc = nonce(12) || ciphertext || tag(16)`. It also writes
   `dist/dek.base64url` and prints the DEK with a loud warning:
   **paste it into your license server's `config.json` as `masterDek` and
   never commit it** (`dist/` is gitignored for exactly this reason).
3. **Bundle the bootstrap** — `src/bootstrap.ts` → `backend/index.js`, plain
   importable ESM with `@catalyst/plugin-sdk/licensing` **inlined** (the panel
   has no such package at runtime, so a bare import would fail at load).

Commit `backend/index.js` and `backend/payload.enc` — those are the shipped
artefacts. A fresh build makes a fresh DEK: rebuild the payload, update
`masterDek`, and bump the plugin version before shipping an update.

(`frontend.mjs` is built separately with the repo's `npm run build:bundles`,
which runs `vite build` per plugin and then **clears `dist/`** — so copy
`dist/dek.base64url` into your license server's `config.json` right after
`npm run build`, before bundling frontends.)

## 4. Pointing at your own license server

`plugin.json`:

```json
"licensing": {
  "licenseServer": "https://licenses.vendor.example/v1/activate",
  "buyUrl": "https://vendor.example/buy",
  "contact": ["support@vendor.example"],
  "encrypted": true,
  "cacheTtlHours": 168
}
```

`licenseServer` **must be `https://`** for anything that is not loopback —
the wrapped DEK is intercepted-proof (GCM auth tag), but the license key
itself travels in the activation request. The `http://127.0.0.1` URL in this
example is the documented loopback development exception; a shipped plugin
uses `https://`. `contact` lists addresses admins can reach when activation
fails; `buyUrl` is shown by the panel when a key is missing.

How the payload learns its entitlements: the bootstrap's
`loadLicensedModule` activates first and caches the activation in plugin
storage; the decrypted payload then calls `activateLicense` in `onLoad`, which
is served from that cache (no second network call) and returns the
`entitlements` list from your `/v1/activate` response.

## 5. End-to-end demo

Frontend note first: `frontend.mjs` cannot use React hooks (it would inline
its own React), so interactive UI must ship as a plugin the panel compiles in.
This example is in the plugins repo so it is compiled in — that is the
intended path. The tab body is `frontend/components.tsx`; the license key
itself is set from the panel's plugin config UI (`config.licenseKey`).

With the license server running and a key issued, walk through this in order:

1. **Enforcement** — enable the plugin with no key configured. The bootstrap
   throws (`licensing: no license key configured`) and the plugin stays
   disabled. (With `encrypted: true` and `failMode` omitted — the default
   `closed` — `activateLicense` throws and the plugin fails to load. That
   throw *is* the enforcement. The manifest text mentions "trial mode"; to
   actually run unentitled, drop `encrypted` and set `failMode: 'open'` —
   `loadLicensedModule` then returns `null` and the bootstrap tolerates it.)
2. **Activation** — paste the key into the plugin config, enable. Then:

   ```sh
   curl -s --cookie "$PANEL_SESSION" \
     http://127.0.0.1:3000/api/plugins/licensed-example/premium-report
   # → { "success": true, "license": "active", "report": {...}, "entitlements": [...] }
   ```

3. **Outage tolerance** — kill the license server, reload the panel. Still
   works: the wrapped DEK is cached for `cacheTtlHours` (default 7 days) in
   the plugin's own storage, so a vendor outage is not a Catalyst incident.
4. **Seats** — enter the same key on a second panel (different `installId`).
   `POST /v1/activate` returns `409 SEAT_EXHAUSTED` (the key was issued with
   `--seats 1`), the bootstrap throws `licensing: activation rejected`,
   plugin stays disabled.
5. **Revocation** — `curl -s http://127.0.0.1:8787/v1/revoke -d '{"licenseKey":"VND1-...","reason":"refund"}'`.
   Nothing changes immediately — the cache still unwraps. Set
   `cacheTtlHours` to `1` to test without waiting: after the cached
   `expiresAt` passes, activation re-contacts the server, gets `403 REVOKED`,
   and the plugin stops loading.

## 6. Threat model (honest version)

**This is a deterrent, not a guarantee.**

It stops:

- **package copying** — the catpkg contains only ciphertext; the plaintext
  payload never ships;
- **key sharing** — keys activate a bounded number of `installId`s (seats),
  and the KEK is bound to the install, so a `wrappedDek` lifted from one
  panel does not unwrap on another;
- **casual patching** — the GCM auth tag means a tampered payload or a forged
  activation response simply fails to decrypt.

It does **not** stop:

- an admin with database access (they can read plugin storage, including the
  cached `wrappedDek`, and they know their own license key — from which the
  KEK, and then the DEK, derive);
- someone who dumps the decrypted module from the running process. Loading
  via `data:` URL keeps the plaintext off disk — the panel's hot-reload
  staging directory never sees it — which raises the bar from "read the
  staging dir" to "attach a debugger", but the plaintext exists in memory by
  definition;
- anything the entitled customer themselves chooses to do with output their
  own panel produces.

Frontend UI cannot be meaningfully encrypted — anything the browser runs, the
user can read. Encrypt the backend, ship a thin UI.

## 7. What actually ships

`npx catalyst-plugin pack` includes **only** `plugin.json`, `README.md`,
`LICENSE`, `backend/`, `frontend/`, `assets/`. Anything else in the package
is rejected at install.

So `payload-src/` (the source of the valuable code), `scripts/`, `src/`,
`package.json` and `vite.config.mts` are **NOT** in the `.catpkg.zip` — the
source of the payload is never shipped. Keep this directory in your private
repo; ship only the packed artefact.

## Files

```
plugin.json           manifest + licensing block + licenseKey config field
src/bootstrap.ts      the entire plaintext surface (source of backend/index.js)
payload-src/index.ts  the valuable code — encrypted, never shipped in the clear
scripts/build.mjs     npm run build: bundle → encrypt → bundle
scripts/encrypt.mjs   step 2: AES-256-GCM payload envelope + DEK handling
backend/index.js      BUILT bootstrap (commit)
backend/payload.enc   BUILT sealed payload (commit)
frontend/index.ts     thin shell tab registration (not encrypted)
frontend/components.tsx  tab body
vite.config.mts       builds frontend.mjs like the sibling plugins
```

## The committed build's DEK (public on purpose)

The `backend/payload.enc` checked into this repository was sealed with a
**published test key** so the example runs end to end out of the box:

```
masterDek = KwBxym-yAsi1BJV9JBHkw7HZCPDdjnAnIGhq71g48h8
```

Put that value in your license server's `config.json` as `masterDek` and the
committed payload will activate. This key is public because it is an example —
it provides **no** protection. For a real plugin, `npm run build` generates a
fresh 32-byte DEK into `dist/dek.base64url`; keep that file out of version
control and paste it into your license server only.

## License

GPL-3.0 — see `LICENSE`.
