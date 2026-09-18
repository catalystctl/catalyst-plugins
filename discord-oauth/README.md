# Discord OAuth

Sign in with Discord, link Discord accounts to panel accounts, and mirror
Discord guild roles onto panel roles — as a Catalyst plugin (no panel
patches required beyond the plugin-system auth bridge shipped in Catalyst
≥ 1.62).

> **Panel requirement: ≥ 1.62.1.** The plugin needs the panel's auth bridge
> (`ctx.auth`, public routes, login-page provider buttons) *and* an
> interactive plugin UI compiled into the panel build — the self-contained
> marketplace bundle cannot use hooks (its inlined React copy is never driven
> by the host renderer). Panels without this plugin's build-time frontend
> refuse to load it with a version error rather than showing a broken UI.
> Update the panel to a release whose frontend image embeds the plugin
> (official images ≥ 1.62.1).

## Features

- **"Continue with Discord" button on the login page** (rendered by the panel
  from the plugin's declared `authProviders` manifest entry).
- **Account linking** — signed-in users link their Discord from the profile
  page (profile → Discord card). Existing accounts can also be matched by
  email on first Discord sign-in (optional, standard OIDC trust model).
- **Auto-registration** — first-time Discord users get a panel account
  (optional; never fires on a fresh panel without an admin).
- **Guild enforcement** — require guild membership and/or specific Discord
  roles to sign in.
- **Role mapping** — map Discord roles → panel roles:
  - *Mirror mode*: mapped panel roles exactly follow the user's Discord roles;
    unmapped panel roles are never touched.
  - *Additive mode*: mappings only add roles.
  - Applied on every sign-in/link and via a **scheduled sync** (cron, bot
    token + Server Members Intent).
- **Admin UI** — admin tab with connection test, guild role browser, mapping
  editor, linked-account list, manual sync, and per-install redirect URI.

## Setup

1. Create an application at <https://discord.com/developers/applications>.
2. **OAuth2 → Redirects**: add the redirect URI shown in the plugin's admin
   tab (`https://your-panel/api/plugins/discord-oauth/callback`).
3. Copy the **Client ID** and **Client Secret** into the plugin's admin tab.
4. *(Optional, for scheduled role sync)* Create a bot user, invite it to your
   guild (`https://discord.com/oauth2/authorize?client_id=<id>&scope=bot`),
   enable **Server Members Intent** in Bot settings, and paste the **Bot
   Token** + your **Guild ID**.
5. Save, run **Test connection**, then build your role mappings.

### Behind a Cloudflare Tunnel or reverse proxy

OAuth redirect URIs must exactly match what Discord has registered, but
proxied dev setups (cloudflared → vite → backend) rewrite the `Host` header
to the last hop (`127.0.0.1:3000`), which would produce a `localhost`
redirect URI. Set **Public URL** in the plugin's admin tab to the origin
users actually visit (e.g. `https://panel.example.com`) — the redirect URI,
the post-login redirect and the callback then all use it consistently.
Leave it empty for direct deployments where the backend sees the real
`Host`/`X-Forwarded-*` headers.

## Security notes

- OAuth state is HMAC-signed (10-minute TTL) and the flow uses PKCE S256.
- User access tokens are never stored; only public Discord profile data is
  kept in the plugin's own link collection.
- All privileged operations (session creation, user lookup/creation, role
  assignment) go through the panel's plugin auth bridge, which enforces the
  plugin's live permission grants (`auth.sessions`, `auth.users`,
  `roles.assign`, `routes.public`) and audits every write. Revoking a grant
  takes effect immediately.
- The plugin cannot create the first panel account (setup wizard stays
  authoritative) and cannot assign roles outside its mappings.

## Permissions

| Grant | Used for |
|---|---|
| `routes.public` | Serve the Discord authorize/callback endpoints without a session |
| `auth.sessions` | Create the panel session cookie after Discord authentication |
| `auth.users` | Look up users by email / create accounts on first sign-in |
| `roles.assign` | Apply Discord→panel role mappings |
| `user.read` | Count users (first-account guard) |
