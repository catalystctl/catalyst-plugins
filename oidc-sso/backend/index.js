/**
 * Generic OIDC Single Sign-On plugin — backend.
 *
 * Lets a panel admin point the panel at any standards-compliant OpenID
 * Connect identity provider (Keycloak, Authentik, Authelia, Google,
 * Microsoft Entra ID, Okta, …) and offer "Continue with SSO" sign-in.
 *
 * Flow (authorization_code + PKCE S256, HMAC-signed state):
 *  - GET  /authorize?provider=<id>&redirect=/servers  (auth: optional)
 *      Single enabled provider → starts the flow directly.
 *      Several enabled providers and no ?provider= → provider picker page.
 *  - GET  /callback?code=…&state=…                    (auth: public)
 *      Exchanges the code, validates the ID token against the provider
 *      JWKS, merges userinfo claims, finds or creates the panel user,
 *      creates a real panel session cookie, redirects back.
 *
 * One callback URL serves every provider (the state carries the provider
 * id), so admins register a single redirect URI at their IdP:
 *   https://panel.example.com/api/plugins/oidc-sso/callback
 *
 * All privileged operations go through the host auth bridge (ctx.auth),
 * which enforces the plugin's live permission grants and audits writes.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  OidcError,
  claimAt,
  exchangeCode,
  fetchDiscovery,
  fetchJwks,
  fetchUserinfo,
  firstString,
  verifyIdToken,
} from './oidc.js';

const STATE_TTL_MS = 10 * 60 * 1000;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const JWKS_TTL_MS = 15 * 60 * 1000;
const PROVIDER_LABEL = 'SSO';

const DEFAULT_SETTINGS = {
  frontendUrl: '',
  loginDisabled: false,
  providers: [],
};

const DEFAULT_PROVIDER = {
  id: '',
  label: '',
  issuer: '',
  discoveryUrl: '',
  clientId: '',
  clientSecret: '',
  scopes: 'openid profile email',
  usePkce: true,
  enabled: true,
  autoRegister: true,
  linkExistingByEmail: true,
  markEmailVerified: true,
  defaultRoleIds: [],
  emailClaim: 'email',
  usernameClaim: 'preferred_username',
  nameClaim: 'name',
  avatarClaim: 'picture',
};

// ── helpers ──────────────────────────────────────────────────────────────

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function safeRelativePath(input, fallback = '/') {
  if (typeof input !== 'string' || !input.startsWith('/') || input.startsWith('//')) return fallback;
  return input;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Validated frontend base URL (no trailing slash) or '' when same-origin. */
function normalizedFrontendUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

/** Origin the browser used to reach the panel (proxy-aware). */
function requestOrigin(request) {
  const proto = String(request.headers?.['x-forwarded-proto'] || request.protocol || 'http')
    .split(',')[0]
    .trim();
  const host = String(request.headers?.['x-forwarded-host'] || request.headers?.host || '')
    .split(',')[0]
    .trim();
  return host ? `${proto}://${host}` : '';
}

/**
 * Public origin used for the OAuth redirect URI and post-login redirects.
 * The configured public origin (settings.frontendUrl) wins: behind tunnels
 * and dev proxies the Host header the backend sees is the last hop, not the
 * hostname users visit — and the redirect_uri must exactly match what's
 * registered at the IdP, so deriving it from a single configured value is
 * the only reliable option. Falls back to proxy-aware headers when unset.
 */
function publicOrigin(request, settings) {
  return normalizedFrontendUrl(settings.frontendUrl) || requestOrigin(request);
}

function callbackUrl(request, settings) {
  return `${publicOrigin(request, settings)}/api/plugins/oidc-sso/callback`;
}

function maskSecret(value) {
  if (!value) return '';
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

function slugifyId(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function sanitizeProvider(raw, storedById) {
  const stored = (raw && raw.id && storedById.get(String(raw.id))) || null;
  const id = slugifyId(raw?.id || stored?.id || raw?.label || '');
  // Write-only secret: undefined/'' keeps the stored value (so masked
  // round-trips don't wipe it), an explicit null clears it.
  let clientSecret;
  if (raw?.clientSecret === null) clientSecret = '';
  else if (typeof raw?.clientSecret === 'string' && raw.clientSecret.trim()) clientSecret = raw.clientSecret.trim();
  else clientSecret = stored?.clientSecret || '';

  const scopes = String(raw?.scopes ?? stored?.scopes ?? DEFAULT_PROVIDER.scopes).trim() || DEFAULT_PROVIDER.scopes;

  return {
    id,
    label: String(raw?.label ?? stored?.label ?? '').trim().slice(0, 80),
    issuer: String(raw?.issuer ?? stored?.issuer ?? '').trim().replace(/\/+$/, ''),
    discoveryUrl: String(raw?.discoveryUrl ?? stored?.discoveryUrl ?? '').trim(),
    clientId: String(raw?.clientId ?? stored?.clientId ?? '').trim(),
    clientSecret,
    scopes,
    usePkce: raw?.usePkce !== undefined ? Boolean(raw.usePkce) : (stored?.usePkce ?? true),
    enabled: raw?.enabled !== undefined ? Boolean(raw.enabled) : (stored?.enabled ?? true),
    autoRegister: raw?.autoRegister !== undefined ? Boolean(raw.autoRegister) : (stored?.autoRegister ?? true),
    linkExistingByEmail:
      raw?.linkExistingByEmail !== undefined
        ? Boolean(raw.linkExistingByEmail)
        : (stored?.linkExistingByEmail ?? true),
    markEmailVerified:
      raw?.markEmailVerified !== undefined ? Boolean(raw.markEmailVerified) : (stored?.markEmailVerified ?? true),
    defaultRoleIds: Array.isArray(raw?.defaultRoleIds)
      ? raw.defaultRoleIds.map(String)
      : (stored?.defaultRoleIds || []),
    emailClaim: String(raw?.emailClaim || stored?.emailClaim || 'email').trim() || 'email',
    usernameClaim:
      String(raw?.usernameClaim || stored?.usernameClaim || 'preferred_username').trim() || 'preferred_username',
    nameClaim: String(raw?.nameClaim || stored?.nameClaim || 'name').trim() || 'name',
    avatarClaim: String(raw?.avatarClaim || stored?.avatarClaim || 'picture').trim() || 'picture',
  };
}

function providerIssues(p) {
  const issues = [];
  if (!p.id) issues.push('missing id');
  if (!p.label) issues.push('missing label');
  if (!p.issuer && !p.discoveryUrl) issues.push('issuer or discovery URL required');
  if (!p.clientId) issues.push('client ID required');
  if (!p.clientSecret) issues.push('client secret required');
  return issues;
}

async function getSettings(ctx) {
  const stored = (await ctx.getStorage('settings')) || {};
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  if (!Array.isArray(merged.providers)) merged.providers = [];
  return merged;
}

async function saveSettings(ctx, settings) {
  await ctx.setStorage('settings', settings);
}

function enabledProviders(settings) {
  return (settings.providers || []).filter((p) => p && p.enabled && p.id);
}

/** Stable per-install secret used to sign OAuth state values. */
async function getStateSecret(ctx) {
  let secret = await ctx.getStorage('stateSecret');
  if (!secret || typeof secret !== 'string' || secret.length < 32) {
    secret = randomBytes(32).toString('hex');
    await ctx.setStorage('stateSecret', secret);
  }
  return secret;
}

function stateSignature(payloadB64, secret) {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

function encodeState(payload, secret) {
  const payloadB64 = b64url(JSON.stringify(payload));
  return `${payloadB64}.${stateSignature(payloadB64, secret)}`;
}

function decodeState(raw, secret) {
  if (typeof raw !== 'string') throw new Error('missing state');
  const [payloadB64, signature] = raw.split('.');
  if (!payloadB64 || !signature) throw new Error('malformed state');
  const expected = Buffer.from(stateSignature(payloadB64, secret));
  const got = Buffer.from(signature);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
    throw new Error('invalid state signature');
  }
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  if (!payload?.exp || Date.now() > payload.exp) throw new Error('state expired');
  return payload;
}

/** Pick an unused panel username derived from the IdP one. */
async function availableUsername(ctx, base) {
  const clean =
    String(base || 'sso')
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '')
      .slice(0, 24) || 'sso';
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = attempt === 0 ? clean : `${clean}-${randomBytes(2).toString('hex')}`;
    const existing = await ctx.auth.findUser({ username: candidate });
    if (!existing) return candidate;
  }
  return `${clean}-${randomBytes(4).toString('hex')}`;
}

function loginFailureUrl(code, base = '') {
  return `${base}/login?oauthError=${encodeURIComponent(code)}&providerLabel=${encodeURIComponent(PROVIDER_LABEL)}`;
}

async function cachedDiscovery(ctx, provider) {
  const key = `discovery:${provider.id}`;
  const now = Date.now();
  const cached = await ctx.getStorage(key).catch(() => null);
  if (cached && cached.at && now - cached.at < DISCOVERY_TTL_MS && cached.doc?.authorization_endpoint) {
    return { doc: cached.doc, cached: true };
  }
  const doc = await fetchDiscovery(provider);
  await ctx.setStorage(key, { at: now, doc }).catch(() => {});
  return { doc, cached: false };
}

async function cachedJwks(ctx, jwksUri) {
  const hash = createHash('sha256').update(jwksUri).digest('hex').slice(0, 16);
  const key = `jwks:${hash}`;
  const now = Date.now();
  const cached = await ctx.getStorage(key).catch(() => null);
  if (cached && cached.at && now - cached.at < JWKS_TTL_MS && Array.isArray(cached.doc?.keys)) {
    return cached.doc;
  }
  const doc = await fetchJwks(jwksUri);
  await ctx.setStorage(key, { at: now, uri: jwksUri, doc }).catch(() => {});
  return doc;
}

// ── plugin ───────────────────────────────────────────────────────────────

const plugin = {
  async onLoad(ctx) {
    ctx.logger.info('oidc-sso loaded');

    const links = () => ctx.collection('links');
    const requireAdminRead = ctx.requirePermission?.('admin.read');
    const requireAdminWrite = ctx.requirePermission?.('admin.write');

    /** Redirect (302) helper that never throws. */
    const redirect = (reply, url) => {
      reply.header('Location', url);
      return reply.status(302).send();
    };

    function pickerHtml(list, redirectTarget) {
      const items = list
        .map(
          (p) =>
            `<a class="provider" href="/api/plugins/oidc-sso/authorize?provider=${encodeURIComponent(p.id)}&amp;redirect=${encodeURIComponent(redirectTarget)}"><span class="dot"></span><span><strong>${escapeHtml(p.label)}</strong><small>${escapeHtml(p.issuer || 'SSO')}</small></span><span class="arrow">→</span></a>`,
        )
        .join('');
      return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in with SSO</title><style>
:root{color-scheme:light dark}body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;background:#0f1115;color:#e8eaf0;padding:24px;box-sizing:border-box}
.card{width:100%;max-width:420px;background:#171a21;border:1px solid #2a2f3a;border-radius:14px;padding:28px;box-shadow:0 12px 40px rgba(0,0,0,.4)}
h1{font-size:18px;margin:0 0 4px}p.sub{margin:0 0 20px;color:#9aa3b2;font-size:13px}.provider{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid #2a2f3a;border-radius:10px;margin-bottom:10px;color:inherit;text-decoration:none;background:#1e232e}.provider:hover{border-color:#4f7cff;background:#232a3a}.provider small{display:block;color:#9aa3b2;font-size:12px}.dot{width:10px;height:10px;border-radius:50%;background:#4f7cff;flex-shrink:0}.arrow{margin-left:auto;color:#9aa3b2}.hint{margin-top:16px;font-size:12px;color:#9aa3b2;text-align:center}
</style></head><body><div class="card"><h1>Sign in with SSO</h1><p class="sub">Choose where to sign in — you'll return here afterwards.</p>${items}<div class="hint">Single sign-on is managed by your administrator.</div></div></body></html>`;
    }

    // ── Public: list enabled providers (picker data, diagnostics) ──────
    ctx.registerRoute({
      method: 'GET',
      url: '/providers',
      config: { auth: 'public' },
      handler: async () => {
        const settings = await getSettings(ctx);
        if (settings.loginDisabled) return { success: true, disabled: true, providers: [] };
        return {
          success: true,
          providers: enabledProviders(settings).map((p) => ({ id: p.id, label: p.label })),
        };
      },
    });

    // ── Public/optional: start sign-in (or link) ────────────────────────
    ctx.registerRoute({
      method: 'GET',
      url: '/authorize',
      config: { auth: 'optional' },
      handler: async (request, reply) => {
        const settings = await getSettings(ctx);
        if (settings.loginDisabled) return redirect(reply, loginFailureUrl('disabled'));

        const available = enabledProviders(settings);
        if (available.length === 0) return redirect(reply, loginFailureUrl('not_configured'));

        const redirectTarget = safeRelativePath(request.query?.redirect, '/');
        const userId = ctx.getUserId?.(request) ?? null;
        const requestedId = String(request.query?.provider || '').trim();
        const mode =
          userId && (request.query?.mode === 'link' || request.query?.link === '1') ? 'link' : 'login';

        let provider = requestedId ? available.find((p) => p.id === requestedId) : null;
        if (requestedId && !provider) return redirect(reply, loginFailureUrl('unknown_provider'));
        if (!provider && available.length === 1) provider = available[0];
        if (!provider) {
          // Several providers and none chosen → server-rendered picker that
          // preserves the post-login redirect for every option.
          reply.header('Content-Type', 'text/html; charset=utf-8');
          return reply.status(200).send(pickerHtml(available, redirectTarget));
        }
        if (providerIssues(provider).length > 0) {
          ctx.logger.warn({ providerId: provider.id }, 'oidc-sso: provider misconfigured');
          return redirect(reply, loginFailureUrl('not_configured'));
        }

        let discovery;
        try {
          ({ doc: discovery } = await cachedDiscovery(ctx, provider));
        } catch (err) {
          ctx.logger.warn({ error: err.message, providerId: provider.id }, 'oidc-sso: discovery failed');
          return redirect(reply, loginFailureUrl('discovery_failed'));
        }

        const codeVerifier = provider.usePkce !== false ? b64url(randomBytes(48)) : null;
        const nonce = b64url(randomBytes(16));
        const state = encodeState(
          {
            v: 1,
            providerId: provider.id,
            mode,
            userId,
            redirect: mode === 'login' ? redirectTarget : null,
            verifier: codeVerifier,
            nonce,
            exp: Date.now() + STATE_TTL_MS,
          },
          await getStateSecret(ctx),
        );

        const params = new URLSearchParams({
          client_id: provider.clientId,
          redirect_uri: callbackUrl(request, settings),
          response_type: 'code',
          scope: provider.scopes || 'openid profile email',
          state,
          nonce,
        });
        if (codeVerifier) {
          params.set('code_challenge', createHash('sha256').update(codeVerifier).digest('base64url'));
          params.set('code_challenge_method', 'S256');
        }
        return redirect(reply, `${discovery.authorization_endpoint}?${params}`);
      },
    });

    // ── Public: OAuth callback ─────────────────────────────────────────
    ctx.registerRoute({
      method: 'GET',
      url: '/callback',
      config: { auth: 'public' },
      handler: async (request, reply) => {
        const settings = await getSettings(ctx);
        const base = normalizedFrontendUrl(settings.frontendUrl);
        try {
          if (request.query?.error) {
            ctx.logger.warn({ error: request.query.error }, 'oidc-sso: provider returned an error');
            return redirect(reply, loginFailureUrl(String(request.query.error_description || request.query.error).slice(0, 60), base));
          }
          const code = String(request.query?.code || '');
          const rawState = String(request.query?.state || '');
          if (!code) return redirect(reply, loginFailureUrl('missing_code', base));

          let state;
          try {
            state = decodeState(rawState, await getStateSecret(ctx));
          } catch (err) {
            ctx.logger.warn({ error: err.message }, 'oidc-sso: rejecting state');
            return redirect(reply, loginFailureUrl('bad_state', base));
          }

          const provider = (settings.providers || []).find((p) => p.id === state.providerId);
          if (!provider || !provider.enabled) {
            return redirect(reply, loginFailureUrl('unknown_provider', base));
          }

          const { doc: discovery } = await cachedDiscovery(ctx, provider);
          const redirectUri = `${publicOrigin(request, settings)}/api/plugins/oidc-sso/callback`;

          let tokens;
          try {
            tokens = await exchangeCode({
              tokenEndpoint: discovery.token_endpoint,
              clientId: provider.clientId,
              clientSecret: provider.clientSecret,
              code,
              redirectUri,
              codeVerifier: state.verifier,
            });
          } catch (err) {
            ctx.logger.warn({ error: err.message, providerId: provider.id }, 'oidc-sso: code exchange failed');
            return redirect(reply, loginFailureUrl('token_exchange_failed', base));
          }

          // Verify the ID token when the provider issued one; otherwise fall
          // back to userinfo claims (TLS + token-endpoint auth still bind the
          // response to this flow's code + redirect URI).
          let idClaims = {};
          if (tokens?.id_token) {
            try {
              if (!discovery.jwks_uri) throw new OidcError('No JWKS URI in discovery document', { code: 'bad_discovery' });
              const jwks = await cachedJwks(ctx, discovery.jwks_uri);
              idClaims = verifyIdToken(tokens.id_token, {
                jwks,
                clientId: provider.clientId,
                issuer: discovery.issuer,
                nonce: state.nonce,
              });
            } catch (err) {
              ctx.logger.warn({ error: err.message, providerId: provider.id }, 'oidc-sso: ID token rejected');
              return redirect(reply, loginFailureUrl('bad_id_token', base));
            }
          }

          let userClaims = {};
          if (tokens?.access_token && discovery.userinfo_endpoint) {
            try {
              userClaims = await fetchUserinfo(discovery.userinfo_endpoint, tokens.access_token);
            } catch (err) {
              ctx.logger.warn({ error: err.message, providerId: provider.id }, 'oidc-sso: userinfo failed');
              // Non-fatal when we already hold verified ID-token claims.
              if (!tokens?.id_token) return redirect(reply, loginFailureUrl('profile_failed', base));
            }
          }

          const claims = { ...idClaims, ...userClaims };
          const sub = firstString(claims.sub, userClaims.sub, idClaims.sub);
          if (!sub) return redirect(reply, loginFailureUrl('profile_failed', base));

          const email = firstString(claimAt(claims, provider.emailClaim || 'email'));
          const usernameClaim = firstString(
            claimAt(claims, provider.usernameClaim || 'preferred_username'),
            claims.preferred_username,
            claims.nickname,
          );
          const displayName = firstString(
            claimAt(claims, provider.nameClaim || 'name'),
            claims.name,
            usernameClaim,
          );
          const avatar = firstString(claimAt(claims, provider.avatarClaim || 'picture'), claims.picture);

          if (state.mode === 'link') {
            return await handleLinkMode(ctx, {
              state,
              settings,
              provider,
              base,
              sub,
              email,
              usernameClaim,
              displayName,
              reply,
              redirect,
            });
          }
          return await handleLoginMode(ctx, {
            state,
            settings,
            provider,
            base,
            sub,
            email,
            claims,
            usernameClaim,
            displayName,
            avatar,
            request,
            reply,
            redirect,
          });
        } catch (err) {
          ctx.logger.error({ error: err.message }, 'oidc-sso callback failed');
          return redirect(reply, loginFailureUrl('failed', base));
        }
      },
    });

    /** Shared link-mode handling (called from the callback). */
    async function handleLinkMode(
      ctxArg,
      { state, provider, base, sub, email, usernameClaim, displayName, reply, redirect: doRedirect },
    ) {
      if (!state.userId) return doRedirect(reply, loginFailureUrl('link_no_user', base));
      const existing = await links().findOne({ providerId: provider.id, sub });
      if (existing && existing.userId !== state.userId) {
        return doRedirect(reply, `${base}/servers?oauthError=${encodeURIComponent('sso_taken')}`);
      }
      const doc = {
        providerId: provider.id,
        sub,
        userId: state.userId,
        email: email || null,
        username: usernameClaim || null,
        name: displayName || null,
        linkedAt: existing?.linkedAt || new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
      };
      if (existing) await links().update({ providerId: provider.id, sub }, { $set: doc });
      else await links().insert(doc);
      ctxArg.emit('oidc:account_linked', {
        userId: state.userId,
        providerId: provider.id,
        sub,
        mode: 'link',
      });
      return doRedirect(reply, `${base}/servers?oidc=linked`);
    }

    /** Shared login-mode handling (called from the callback). */
    async function handleLoginMode(
      ctxArg,
      { state, settings, provider, base, sub, email, claims, usernameClaim, displayName, avatar, request, reply, redirect: doRedirect },
    ) {
      let link = await links().findOne({ providerId: provider.id, sub });
      let panelUser = null;
      let created = false;

      if (link) {
        panelUser = await ctx.auth.findUser({ userId: link.userId });
      }

      if (!panelUser && provider.linkExistingByEmail !== false && email) {
        panelUser = await ctx.auth.findUser({ email });
        if (panelUser) {
          link = { providerId: provider.id, sub, userId: panelUser.id };
          await links().insert({
            providerId: provider.id,
            sub,
            userId: panelUser.id,
            email,
            username: usernameClaim || null,
            name: displayName || null,
            linkedAt: new Date().toISOString(),
            lastLoginAt: new Date().toISOString(),
          });
          ctxArg.emit('oidc:account_linked', {
            userId: panelUser.id,
            providerId: provider.id,
            sub,
            mode: 'email',
          });
        }
      }

      if (!panelUser && provider.autoRegister !== false) {
        // Never create the FIRST panel account via SSO — the initial
        // admin must come from the setup wizard.
        const userCount = await ctx.db.users.count();
        if (userCount === 0) return doRedirect(reply, loginFailureUrl('setup_required', base));

        const username = await availableUsername(
          ctx,
          usernameClaim || (email ? email.split('@')[0] : `${provider.id}-${sub.slice(0, 8)}`),
        );
        const emailVerified =
          claims.email_verified === true ||
          (provider.markEmailVerified !== false && Boolean(email));
        panelUser = await ctx.auth.createUser({
          email: email || `${provider.id}-${createHash('sha256').update(sub).digest('hex').slice(0, 12)}@oidc.local`,
          username,
          name: displayName || username,
          emailVerified,
          image: avatar || null,
        });
        created = true;
        await links().insert({
          providerId: provider.id,
          sub,
          userId: panelUser.id,
          email: email || null,
          username: usernameClaim || null,
          name: displayName || null,
          linkedAt: new Date().toISOString(),
          lastLoginAt: new Date().toISOString(),
        });
        ctxArg.emit('oidc:account_linked', {
          userId: panelUser.id,
          providerId: provider.id,
          sub,
          mode: 'register',
        });

        if (Array.isArray(provider.defaultRoleIds) && provider.defaultRoleIds.length > 0) {
          try {
            await ctx.auth.assignRoles(panelUser.id, provider.defaultRoleIds, {
              reason: 'oidc-sso registration defaults',
            });
          } catch (err) {
            ctxArg.logger.warn({ error: err.message }, 'oidc-sso: default roles failed');
          }
        }
      }

      if (!panelUser) return doRedirect(reply, loginFailureUrl('no_account', base));

      if (panelUser.banned) return doRedirect(reply, loginFailureUrl('banned', base));
      if (panelUser.lockedUntil && new Date(panelUser.lockedUntil) > new Date()) {
        return doRedirect(reply, loginFailureUrl('locked', base));
      }

      // Keep the link fresh (IdP username/email change over time).
      await links().update(
        { providerId: provider.id, sub },
        {
          $set: {
            userId: panelUser.id,
            email: email || null,
            username: usernameClaim || null,
            name: displayName || null,
            lastLoginAt: new Date().toISOString(),
          },
        },
      );

      await ctx.auth.createSession(panelUser.id, {
        reply,
        rememberMe: true,
        ipAddress: request.ip,
        userAgent: String(request.headers?.['user-agent'] || ''),
      });

      ctxArg.emit('oidc:user_signed_in', {
        userId: panelUser.id,
        providerId: provider.id,
        sub,
        created,
      });
      ctxArg.logger.info({ userId: panelUser.id, providerId: provider.id, created }, 'oidc-sso sign-in');

      return doRedirect(reply, `${base}${safeRelativePath(state.redirect)}`);
    }

    // ── Authenticated: own linked identities ───────────────────────────
    ctx.registerRoute({
      method: 'GET',
      url: '/link',
      handler: async (request, reply) => {
        const providerId = String(request.query?.provider || '');
        const suffix = providerId ? `?provider=${encodeURIComponent(providerId)}&mode=link` : '?mode=link';
        return redirect(reply, `/api/plugins/oidc-sso/authorize${suffix}`);
      },
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/me',
      handler: async (request) => {
        const userId = ctx.getUserId?.(request);
        const all = userId ? await links().find({ userId }, { limit: 50 }) : [];
        return { success: true, links: all };
      },
    });

    ctx.registerRoute({
      method: 'DELETE',
      url: '/me',
      handler: async (request, reply) => {
        const userId = ctx.getUserId?.(request);
        if (!userId) return reply.status(401).send({ success: false, error: 'Not signed in' });
        const providerId = String(request.query?.provider || '');
        if (providerId) {
          const link = await links().findOne({ userId, providerId });
          if (!link) return reply.status(404).send({ success: false, error: 'No linked identity for that provider' });
          await links().delete({ userId, providerId });
          ctx.emit('oidc:account_unlinked', { userId, providerId, sub: link.sub });
        } else {
          const all = await links().find({ userId }, { limit: 50 });
          await links().delete({ userId });
          for (const l of all) ctx.emit('oidc:account_unlinked', { userId, providerId: l.providerId, sub: l.sub });
        }
        return { success: true };
      },
    });

    // ── Admin: settings & diagnostics ──────────────────────────────────
    ctx.registerRoute({
      method: 'GET',
      url: '/settings',
      preHandler: requireAdminRead,
      handler: async (request) => {
        const settings = await getSettings(ctx);
        return {
          success: true,
          config: {
            frontendUrl: settings.frontendUrl || '',
            loginDisabled: Boolean(settings.loginDisabled),
            providers: (settings.providers || []).map((p) => ({
              ...p,
              clientSecret: maskSecret(p.clientSecret),
              hasClientSecret: Boolean(p.clientSecret),
              issues: providerIssues(p),
            })),
          },
          redirectUri: callbackUrl(request, settings),
        };
      },
    });

    ctx.registerRoute({
      method: 'PUT',
      url: '/settings',
      preHandler: requireAdminWrite,
      handler: async (request) => {
        const body = request.body || {};
        const current = await getSettings(ctx);
        const storedById = new Map((current.providers || []).map((p) => [p.id, p]));

        let providers = current.providers || [];
        if (Array.isArray(body.providers)) {
          const seen = new Set();
          providers = [];
          for (const raw of body.providers) {
            const next = sanitizeProvider(raw, storedById);
            if (!next.id || seen.has(next.id)) continue; // drop blanks/dupes
            seen.add(next.id);
            providers.push(next);
          }
        }

        const next = {
          frontendUrl: normalizedFrontendUrl(
            body.frontendUrl !== undefined ? String(body.frontendUrl) : current.frontendUrl,
          ),
          loginDisabled: body.loginDisabled !== undefined ? Boolean(body.loginDisabled) : current.loginDisabled,
          providers,
        };
        await saveSettings(ctx, next);
        return { success: true };
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/settings/test',
      preHandler: requireAdminRead,
      handler: async (request, reply) => {
        const settings = await getSettings(ctx);
        const providerId = String(request.body?.providerId || request.query?.providerId || '');
        const provider = (settings.providers || []).find((p) => p.id === providerId);
        if (!provider) {
          return reply.status(404).send({ success: false, error: 'Unknown provider id' });
        }
        const result = {
          success: true,
          providerId: provider.id,
          clientConfigured: Boolean(provider.clientId && provider.clientSecret),
          issues: providerIssues(provider),
        };
        try {
          const discovery = await fetchDiscovery(provider);
          result.discovery = {
            ok: true,
            issuer: discovery.issuer,
            authorizationEndpoint: discovery.authorization_endpoint,
            tokenEndpoint: discovery.token_endpoint,
            userinfoEndpoint: discovery.userinfo_endpoint || null,
            jwksUri: discovery.jwks_uri || null,
          };
          await ctx.setStorage(`discovery:${provider.id}`, { at: Date.now(), doc: discovery }).catch(() => {});
          if (discovery.jwks_uri) {
            try {
              const jwks = await fetchJwks(discovery.jwks_uri);
              result.jwks = { ok: true, keys: jwks.keys.length };
            } catch (err) {
              result.jwks = { ok: false, error: err.message };
            }
          } else {
            result.jwks = { ok: false, error: 'No JWKS URI in discovery document' };
          }
        } catch (err) {
          result.discovery = { ok: false, error: err.message };
        }
        return result;
      },
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/panel-roles',
      preHandler: requireAdminRead,
      handler: async () => {
        const roles = await ctx.auth.listRoles();
        return { success: true, roles };
      },
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/status',
      preHandler: requireAdminRead,
      handler: async (request) => {
        const settings = await getSettings(ctx);
        const linkCount = await links().count();
        return {
          success: true,
          loginDisabled: Boolean(settings.loginDisabled),
          providers: (settings.providers || []).map((p) => ({
            id: p.id,
            label: p.label,
            enabled: p.enabled,
            ready: providerIssues(p).length === 0,
            issues: providerIssues(p),
          })),
          linkCount,
          redirectUri: callbackUrl(request, settings),
        };
      },
    });

    // Expose for other plugins (e.g. a welcome-bot could check links).
    ctx.exposeApi('getLink', async (params) =>
      links().findOne({ userId: params?.userId, ...(params?.providerId ? { providerId: params.providerId } : {}) }),
    );

    ctx.logger.info('oidc-sso routes registered');
  },

  async onEnable(ctx) {
    ctx.logger.info('oidc-sso enabled');
  },

  async onDisable(ctx) {
    ctx.logger.info('oidc-sso disabled');
  },
};

export default plugin;
