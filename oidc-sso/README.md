# OIDC Single Sign-On

Generic OpenID Connect single sign-on for the Catalyst panel, as a plugin
(no panel patches required beyond the plugin-system auth bridge shipped in
Catalyst ≥ 1.62.1).

Point the panel at any standards-compliant identity provider — Keycloak,
Authentik, Authelia, Google, Microsoft Entra ID, Okta, Zitadel, … — and
users get a **“Continue with SSO”** button on the login page. Configure
several providers and users pick theirs on a provider page; configure one
and sign-in starts immediately.

> **Panel requirement: ≥ 1.62.1.** The plugin needs the panel's auth bridge
> (`ctx.auth`, public routes, login-page provider buttons) *and* an
> interactive plugin UI compiled into the panel build — the self-contained
> marketplace bundle cannot use hooks (its inlined React copy is never driven
> by the host renderer). Panels without this plugin's build-time frontend
> refuse to load it with a version error rather than showing a broken UI.

## Features

- **“Continue with SSO” button on the login page** (rendered by the panel
  from the plugin's declared `authProviders` manifest entry).
- **Multiple identity providers** — each with its own issuer, client
  credentials, scopes, claim mappings and sign-in rules. One provider →
  direct sign-in; several → a provider picker that preserves the post-login
  destination.
- **Standard OIDC**: discovery (`/.well-known/openid-configuration`),
  authorization-code flow with **PKCE S256**, HMAC-signed state (10-minute
  TTL), `nonce` binding, and **ID-token signature verification against the
  provider JWKS** (RS256/384/512, ES256/384/512) including issuer, audience,
  expiry and nonce checks. Userinfo claims are merged in.
- **Account provisioning** — first-time SSO users get a panel account
  (optional; never fires on a fresh panel without an admin), existing
  accounts match by email (optional, standard OIDC trust model), and
  configurable claim names map email / username / display name / avatar.
- **Default panel roles** for SSO-created accounts.
- **Admin UI** — provider list with per-provider connection test (discovery
  + signing keys), a single shared redirect URI, and public-URL override for
  tunnel/proxy setups.
- **Link management API** — `GET /me` lists the signed-in user's linked SSO
  identities, `DELETE /me[?provider=]` unlinks them; `GET /link?provider=`
  links an additional provider to the current session.

## Setup

1. At your identity provider, create a new OIDC client:
   - **Application type**: Web / confidential client.
   - **Redirect URI**: the URI shown in the plugin's admin tab
     (`https://your-panel/api/plugins/oidc-sso/callback` — one URI for all
     providers).
   - **Scopes**: `openid profile email` (defaults are fine).
2. In the panel (**Admin → OIDC Single Sign-On**), **Add identity provider**:
   give it a label, paste the **issuer URL** and the **client ID/secret**.
3. Save, run **Test** — discovery and signing keys should both report OK.
4. Try **“Continue with SSO”** on the login page.

### Issuer URLs

| Provider | Issuer |
|---|---|
| Keycloak | `https://auth.example.com/realms/<realm>` |
| Authentik | `https://auth.example.com/application/o/<provider-slug>/` (ak-proxy outposts differ — use the value from your provider's “OpenID Configuration Issuer”) |
| Authelia | `https://auth.example.com` |
| Google | `https://accounts.google.com` |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| Okta | `https://<your-domain>.okta.com/oauth2/default` |
| Zitadel | `https://<instance>` |

If your provider serves discovery somewhere unusual, set the **discovery URL
override** instead of the issuer.

### Behind a Cloudflare Tunnel or reverse proxy

The redirect URI must exactly match what the IdP has registered, but proxied
setups (cloudflared → vite → backend) rewrite the `Host` header to the last
hop (`127.0.0.1:3000`), which would produce a `localhost` redirect URI. Set
**Public URL** in the plugin's admin tab to the origin users actually visit
(e.g. `https://panel.example.com`). Leave it empty for direct deployments
where the backend sees the real `Host`/`X-Forwarded-*` headers.

## Security notes

- OAuth state is HMAC-signed (10-minute TTL); the flow uses PKCE S256 and a
  per-attempt `nonce` bound to the ID token.
- ID tokens are signature-checked against the provider's JWKS (issuer,
  audience = client ID, expiry, nonce). Responses without an ID token fall
  back to userinfo claims fetched over TLS with the freshly-exchanged access
  token.
- User access tokens are never stored; only the subject, basic profile
  claims and link metadata are kept in the plugin's own link collection.
- Client secrets are write-only (masked in reads, `null` clears).
- All privileged operations (session creation, user lookup/creation, role
  assignment) go through the panel's plugin auth bridge, which enforces the
  plugin's live permission grants (`auth.sessions`, `auth.users`,
  `roles.assign`, `routes.public`) and audits every write. Revoking a grant
  takes effect immediately.
- The plugin cannot create the first panel account (setup wizard stays
  authoritative).

## Permissions

| Grant | Used for |
|---|---|
| `routes.public` | Serve the authorize/callback/provider endpoints without a session |
| `auth.sessions` | Create the panel session cookie after IdP authentication |
| `auth.users` | Look up users by email / create accounts on first sign-in |
| `roles.assign` | Apply default panel roles to SSO-created accounts |
| `user.read` | Count users (first-account guard) |
