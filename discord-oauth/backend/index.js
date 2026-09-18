/**
 * Discord OAuth plugin — backend.
 *
 * Provides:
 *  - "Continue with Discord" sign-in (public authorize/callback routes)
 *  - Account linking for signed-in users (/link, /me, DELETE /me)
 *  - Discord-role → panel-role mappings, applied on sign-in and via a
 *    scheduled sync (bot token + Server Members intent)
 *  - Admin API: settings, connection test, guild/role discovery, link list,
 *    manual sync
 *
 * All privileged operations go through the host auth bridge (ctx.auth),
 * which enforces the plugin's live permission grants and audits writes.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  DiscordApiError,
  OAUTH_SCOPES,
  avatarUrl,
  exchangeCode,
  fetchBotUser,
  fetchGuild,
  fetchGuildRoles,
  fetchMe,
  fetchMyGuildMember,
} from './discord.js';
import { syncAllLinks, syncUserRoles } from './sync.js';

const STATE_TTL_MS = 10 * 60 * 1000;
const PROVIDER_LABEL = 'Discord';

const DEFAULT_SETTINGS = {
  clientId: '',
  clientSecret: '',
  botToken: '',
  guildId: '',
  // Public origin users actually visit (e.g. https://panel.example.com).
  // Set when proxies hide it from the backend — cloudflared/vite dev setups
  // make the backend see Host 127.0.0.1:3000, which would leak into OAuth
  // redirect URIs. Used for the Discord redirect_uri and post-login
  // redirects. Empty = derive from proxy-aware request headers.
  frontendUrl: '',
  requireGuildMembership: true,
  requiredDiscordRoleIds: [],
  autoRegister: true,
  linkExistingByEmail: true,
  markEmailVerified: true,
  defaultRoleIds: [],
  roleMappings: [],
  syncMode: 'replaceManaged',
  syncSchedule: '0 * * * *',
  syncEnabled: false,
  loginDisabled: false,
  removeLinkOnLeave: false,
};

// ── helpers ──────────────────────────────────────────────────────────────

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function safeRelativePath(input, fallback = '/') {
  if (typeof input !== 'string' || !input.startsWith('/') || input.startsWith('//')) return fallback;
  return input;
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
 * Public origin used for OAuth redirect URIs and post-login redirects.
 * The configured public origin (settings.frontendUrl) wins: behind tunnels
 * and dev proxies (cloudflared → vite → backend) the Host header the backend
 * sees is the last hop (e.g. 127.0.0.1:3000), not the hostname users visit —
 * and the redirect_uri must exactly match what's registered in Discord, so
 * deriving it from a single configured value is the only reliable option.
 * Falls back to proxy-aware request headers when unset (direct deployments).
 */
function publicOrigin(request, settings) {
  return normalizedFrontendUrl(settings.frontendUrl) || requestOrigin(request);
}

function maskSecret(value) {
  if (!value) return '';
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

async function getSettings(ctx) {
  const stored = (await ctx.getStorage('settings')) || {};
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function saveSettings(ctx, settings) {
  await ctx.setStorage('settings', settings);
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

/** Pick an unused panel username derived from the Discord one. */
async function availableUsername(ctx, base) {
  const clean = String(base || 'discord')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 24) || 'discord';
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

// ── plugin ───────────────────────────────────────────────────────────────

const plugin = {
  async onLoad(ctx) {
    ctx.logger.info('discord-oauth loaded');

    const links = () => ctx.collection('links');
    const requireAdminRead = ctx.requirePermission?.('admin.read');
    const requireAdminWrite = ctx.requirePermission?.('admin.write');

    /** Redirect (302) helper that never throws. */
    const redirect = (reply, url) => {
      reply.header('Location', url);
      return reply.status(302).send();
    };

    // ── Public: start OAuth ────────────────────────────────────────────
    ctx.registerRoute({
      method: 'GET',
      url: '/authorize',
      config: { auth: 'optional' },
      handler: async (request, reply) => {
        const settings = await getSettings(ctx);
        if (settings.loginDisabled) return redirect(reply, loginFailureUrl('disabled'));
        if (!settings.clientId || !settings.clientSecret) {
          return redirect(reply, loginFailureUrl('not_configured'));
        }

        const origin = publicOrigin(request, settings);
        const userId = ctx.getUserId?.(request) ?? null;
        const mode = userId && request.query?.mode === 'link' ? 'link' : 'login';

        const codeVerifier = b64url(randomBytes(48));
        const state = encodeState(
          {
            mode,
            userId,
            redirect: mode === 'login' ? safeRelativePath(request.query?.redirect, '/') : null,
            verifier: codeVerifier,
            exp: Date.now() + STATE_TTL_MS,
          },
          await getStateSecret(ctx),
        );

        const params = new URLSearchParams({
          client_id: settings.clientId,
          redirect_uri: `${origin}/api/plugins/discord-oauth/callback`,
          response_type: 'code',
          scope: OAUTH_SCOPES.join(' '),
          state,
          code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
          code_challenge_method: 'S256',
          prompt: 'consent',
        });
        return redirect(reply, `https://discord.com/oauth2/authorize?${params}`);
      },
    });

    // ── Public: OAuth callback ─────────────────────────────────────────
    ctx.registerRoute({
      method: 'GET',
      url: '/callback',
      config: { auth: 'public' },
      handler: async (request, reply) => {
        try {
          const settings = await getSettings(ctx);
          const base = normalizedFrontendUrl(settings.frontendUrl);
          const code = String(request.query?.code || '');
          const rawState = String(request.query?.state || '');
          if (!code) return redirect(reply, loginFailureUrl('missing_code', base));

          let state;
          try {
            state = decodeState(rawState, await getStateSecret(ctx));
          } catch (err) {
            ctx.logger.warn({ error: err.message }, 'discord-oauth: rejecting state');
            return redirect(reply, loginFailureUrl('bad_state', base));
          }

          const tokenResponse = await exchangeCode({
            clientId: settings.clientId,
            clientSecret: settings.clientSecret,
            code,
            redirectUri: `${publicOrigin(request, settings)}/api/plugins/discord-oauth/callback`,
            codeVerifier: state.verifier,
          });
          const accessToken = tokenResponse?.access_token;
          if (!accessToken) return redirect(reply, loginFailureUrl('token_exchange_failed', base));

          const discordUser = await fetchMe(accessToken);
          if (!discordUser?.id) return redirect(reply, loginFailureUrl('profile_failed', base));

          // Guild context (optional): fetch the member via the user token.
          let memberRoles = null;
          if (settings.guildId) {
            try {
              const member = await fetchMyGuildMember(accessToken, settings.guildId);
              memberRoles = member?.roles ?? [];
            } catch (err) {
              if (err instanceof DiscordApiError && (err.status === 403 || err.status === 404)) {
                memberRoles = null; // not a member / guild hidden
              } else {
                throw err;
              }
            }
          }
          if (settings.guildId && settings.requireGuildMembership && memberRoles === null) {
            return redirect(reply, loginFailureUrl('guild_required', base));
          }
          if (
            Array.isArray(settings.requiredDiscordRoleIds) &&
            settings.requiredDiscordRoleIds.length > 0 &&
            memberRoles !== null &&
            !settings.requiredDiscordRoleIds.some((rid) => memberRoles.includes(rid))
          ) {
            return redirect(reply, loginFailureUrl('role_required', base));
          }

          if (state.mode === 'link') {
            return await handleLinkMode(ctx, { state, settings, base, discordUser, memberRoles, reply, redirect });
          }
          return await handleLoginMode(ctx, {
            state,
            settings,
            base,
            discordUser,
            memberRoles,
            request,
            reply,
            redirect,
          });
        } catch (err) {
          ctx.logger.error({ error: err.message }, 'discord-oauth callback failed');
          return redirect(reply, loginFailureUrl('failed'));
        }
      },
    });

    /** Shared link-mode handling (called from the callback). */
    async function handleLinkMode(ctxArg, { state, settings, base, discordUser, memberRoles, reply, redirect }) {
      if (!state.userId) return redirect(reply, loginFailureUrl('link_no_user', base));
      const existing = await links().findOne({ discordId: discordUser.id });
      if (existing && existing.userId !== state.userId) {
        return redirect(reply, `${base}/profile?oauthError=${encodeURIComponent('discord_taken')}`);
      }

      const doc = {
        userId: state.userId,
        discordId: discordUser.id,
        username: discordUser.username || null,
        globalName: discordUser.global_name || null,
        avatar: avatarUrl(discordUser),
        email: discordUser.email || null,
        nick: null,
        roles: memberRoles ?? [],
        linkedAt: new Date().toISOString(),
        lastSyncedAt: null,
        lastError: null,
      };
      if (existing) {
        await links().update({ discordId: discordUser.id }, { $set: doc });
      } else {
        await links().insert(doc);
      }

      try {
        if (memberRoles !== null && Array.isArray(settings.roleMappings) && settings.roleMappings.length > 0) {
          await syncUserRoles(ctxArg, {
            userId: state.userId,
            discordRoleIds: memberRoles,
            settings,
            trigger: 'link',
          });
        }
      } catch (err) {
        ctxArg.logger.warn({ error: err.message }, 'discord-oauth: role sync after link failed');
      }

      ctxArg.emit('discord:account_linked', { userId: state.userId, discordId: discordUser.id, mode: 'link' });
      return redirect(reply, `${base}/profile?discord=linked`);
    }

    /** Shared login-mode handling (called from the callback). */
    async function handleLoginMode(ctxArg, { state, settings, base, discordUser, memberRoles, request, reply, redirect }) {
      let link = await links().findOne({ discordId: discordUser.id });
      let panelUser = null;
      let created = false;

      if (link) {
        panelUser = await ctx.auth.findUser({ userId: link.userId });
      }

      if (!panelUser && settings.linkExistingByEmail && discordUser.email) {
        panelUser = await ctx.auth.findUser({ email: discordUser.email });
        if (panelUser) {
          // Email match on a verified Discord identity → link accounts.
          link = { userId: panelUser.id, discordId: discordUser.id };
          await links().insert({
            ...link,
            username: discordUser.username || null,
            globalName: discordUser.global_name || null,
            avatar: avatarUrl(discordUser),
            email: discordUser.email,
            nick: null,
            roles: memberRoles ?? [],
            linkedAt: new Date().toISOString(),
            lastSyncedAt: null,
            lastError: null,
          });
          ctxArg.emit('discord:account_linked', { userId: panelUser.id, discordId: discordUser.id, mode: 'email' });
        }
      }

      if (!panelUser && settings.autoRegister) {
        // Never create the FIRST panel account via Discord — the initial
        // admin must come from the setup wizard.
        const userCount = await ctx.db.users.count();
        if (userCount === 0) return redirect(reply, loginFailureUrl('setup_required', base));

        const username = await availableUsername(ctx, discordUser.username || `discord-${discordUser.id}`);
        panelUser = await ctx.auth.createUser({
          email: discordUser.email || `${discordUser.id}@discord.local`,
          username,
          name: discordUser.global_name || discordUser.username || username,
          emailVerified: settings.markEmailVerified !== false,
          image: avatarUrl(discordUser),
        });
        created = true;
        await links().insert({
          userId: panelUser.id,
          discordId: discordUser.id,
          username: discordUser.username || null,
          globalName: discordUser.global_name || null,
          avatar: avatarUrl(discordUser),
          email: discordUser.email || null,
          nick: null,
          roles: memberRoles ?? [],
          linkedAt: new Date().toISOString(),
          lastSyncedAt: null,
          lastError: null,
        });
        ctxArg.emit('discord:account_linked', { userId: panelUser.id, discordId: discordUser.id, mode: 'register' });

        if (Array.isArray(settings.defaultRoleIds) && settings.defaultRoleIds.length > 0) {
          try {
            await ctx.auth.assignRoles(panelUser.id, settings.defaultRoleIds, {
              reason: 'discord-oauth registration defaults',
            });
          } catch (err) {
            ctxArg.logger.warn({ error: err.message }, 'discord-oauth: default roles failed');
          }
        }
      }

      if (!panelUser) return redirect(reply, loginFailureUrl('no_account', base));

      if (panelUser.banned) return redirect(reply, loginFailureUrl('banned', base));
      if (panelUser.lockedUntil && new Date(panelUser.lockedUntil) > new Date()) {
        return redirect(reply, loginFailureUrl('locked', base));
      }

      // Keep the link fresh (Discord username/avatar/roles change).
      await links().update(
        { discordId: discordUser.id },
        {
          $set: {
            userId: panelUser.id,
            username: discordUser.username || null,
            globalName: discordUser.global_name || null,
            avatar: avatarUrl(discordUser),
            email: discordUser.email || null,
            ...(memberRoles !== null ? { roles: memberRoles } : {}),
          },
        },
      );

      try {
        if (memberRoles !== null && Array.isArray(settings.roleMappings) && settings.roleMappings.length > 0) {
          await syncUserRoles(ctxArg, {
            userId: panelUser.id,
            discordRoleIds: memberRoles,
            settings,
            trigger: 'login',
          });
        }
      } catch (err) {
        ctxArg.logger.warn({ error: err.message }, 'discord-oauth: role sync at login failed');
      }

      await ctx.auth.createSession(panelUser.id, {
        reply,
        rememberMe: true,
        ipAddress: request.ip,
        userAgent: String(request.headers?.['user-agent'] || ''),
      });

      ctxArg.emit('discord:user_signed_in', { userId: panelUser.id, discordId: discordUser.id, created });
      ctxArg.logger.info({ userId: panelUser.id, created }, 'discord-oauth sign-in');

      return redirect(reply, `${base}${safeRelativePath(state.redirect)}`);
    }

    // ── Authenticated: account linking ─────────────────────────────────
    ctx.registerRoute({
      method: 'GET',
      url: '/link',
      handler: async (request, reply) => redirect(reply, `/api/plugins/discord-oauth/authorize?mode=link`),
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/me',
      handler: async (request) => {
        const userId = ctx.getUserId?.(request);
        const link = userId ? await links().findOne({ userId }) : null;
        return { success: true, link };
      },
    });

    ctx.registerRoute({
      method: 'DELETE',
      url: '/me',
      handler: async (request, reply) => {
        const userId = ctx.getUserId?.(request);
        if (!userId) return reply.status(401).send({ success: false, error: 'Not signed in' });
        const link = await links().findOne({ userId });
        if (!link) return reply.status(404).send({ success: false, error: 'No Discord account linked' });
        await links().delete({ userId });
        ctx.emit('discord:account_unlinked', { userId, discordId: link.discordId });
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
            ...settings,
            clientSecret: maskSecret(settings.clientSecret),
            botToken: maskSecret(settings.botToken),
            // Flags so the UI knows whether the (masked) secrets are set.
            hasClientSecret: Boolean(settings.clientSecret),
            hasBotToken: Boolean(settings.botToken),
          },
          redirectUri: `${publicOrigin(request, settings)}/api/plugins/discord-oauth/callback`,
          scopes: OAUTH_SCOPES.join(' '),
        };
      },
    });

    ctx.registerRoute({
      method: 'PUT',
      url: '/settings',
      preHandler: requireAdminWrite,
      handler: async (request, reply) => {
        const body = request.body || {};
        const current = await getSettings(ctx);

        // Write-only secrets: undefined/'' keeps the stored value (so masked
        // round-trips don't wipe them), an explicit null clears it.
        const secretOr = (incoming, stored) =>
          incoming === null ? '' : incoming ? String(incoming).trim() : (stored || '');

        const next = {
          clientId: String(body.clientId ?? current.clientId ?? '').trim(),
          clientSecret: secretOr(body.clientSecret, current.clientSecret),
          botToken: secretOr(body.botToken, current.botToken),
          guildId: String(body.guildId ?? current.guildId ?? '').replace(/\D/g, ''),
          frontendUrl: normalizedFrontendUrl(
            body.frontendUrl !== undefined ? String(body.frontendUrl) : current.frontendUrl,
          ),
          requireGuildMembership: body.requireGuildMembership !== undefined ? Boolean(body.requireGuildMembership) : current.requireGuildMembership,
          requiredDiscordRoleIds: Array.isArray(body.requiredDiscordRoleIds)
            ? body.requiredDiscordRoleIds.map(String)
            : (current.requiredDiscordRoleIds || []),
          autoRegister: body.autoRegister !== undefined ? Boolean(body.autoRegister) : current.autoRegister,
          linkExistingByEmail:
            body.linkExistingByEmail !== undefined ? Boolean(body.linkExistingByEmail) : current.linkExistingByEmail,
          markEmailVerified: body.markEmailVerified !== undefined ? Boolean(body.markEmailVerified) : current.markEmailVerified,
          defaultRoleIds: Array.isArray(body.defaultRoleIds) ? body.defaultRoleIds.map(String) : (current.defaultRoleIds || []),
          roleMappings: Array.isArray(body.roleMappings)
            ? body.roleMappings
                .filter((m) => m && typeof m.discordRoleId === 'string' && typeof m.panelRoleId === 'string')
                .map((m) => ({ discordRoleId: m.discordRoleId, panelRoleId: m.panelRoleId }))
            : (current.roleMappings || []),
          syncMode:
            body.syncMode !== undefined ? (body.syncMode === 'addOnly' ? 'addOnly' : 'replaceManaged') : (current.syncMode || 'replaceManaged'),
          syncSchedule: typeof body.syncSchedule === 'string' && body.syncSchedule ? body.syncSchedule : current.syncSchedule,
          syncEnabled: body.syncEnabled !== undefined ? Boolean(body.syncEnabled) : current.syncEnabled,
          loginDisabled: body.loginDisabled !== undefined ? Boolean(body.loginDisabled) : current.loginDisabled,
          removeLinkOnLeave: body.removeLinkOnLeave !== undefined ? Boolean(body.removeLinkOnLeave) : current.removeLinkOnLeave,
        };

        await saveSettings(ctx, next);

        // Re-arm the scheduled task if the schedule changed.
        if (next.syncSchedule !== current.syncSchedule || next.syncEnabled !== current.syncEnabled) {
          await armSyncTask(ctx, next);
        }

        return { success: true };
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/settings/test',
      preHandler: requireAdminRead,
      handler: async (request) => {
        const settings = await getSettings(ctx);
        const result = { success: true, oauthConfigured: Boolean(settings.clientId && settings.clientSecret) };

        if (settings.botToken) {
          try {
            const bot = await fetchBotUser(settings.botToken);
            result.bot = { ok: true, username: bot.username, id: bot.id };
          } catch (err) {
            result.bot = { ok: false, error: err.message };
          }
        } else {
          result.bot = { ok: false, error: 'No bot token configured' };
        }

        if (settings.botToken && settings.guildId) {
          try {
            const guild = await fetchGuild(settings.botToken, settings.guildId);
            result.guild = { ok: true, name: guild.name, id: guild.id, approximateMemberCount: guild.approximate_member_count };
          } catch (err) {
            result.guild = { ok: false, error: err.message };
          }
        } else {
          result.guild = { ok: false, error: 'Bot token and guild id required' };
        }

        return result;
      },
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/guild',
      preHandler: requireAdminRead,
      handler: async (_request, reply) => {
        const settings = await getSettings(ctx);
        if (!settings.botToken || !settings.guildId) {
          return reply
            .status(400)
            .send({ success: false, error: 'Bot token and guild id must be configured first' });
        }
        try {
          const [guild, roles] = await Promise.all([
            fetchGuild(settings.botToken, settings.guildId),
            fetchGuildRoles(settings.botToken, settings.guildId),
          ]);
          return {
            success: true,
            guild: { id: guild.id, name: guild.name, approximateMemberCount: guild.approximate_member_count },
            // Drop @everyone-free role list, highest first as Discord returns it.
            roles: (roles || [])
              .filter((r) => r.id !== settings.guildId)
              .map((r) => ({ id: r.id, name: r.name, color: r.color, position: r.position })),
          };
        } catch (err) {
          return reply.status(502).send({ success: false, error: err.message });
        }
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
      url: '/links',
      preHandler: requireAdminRead,
      handler: async (request) => {
        const page = Math.max(1, Number(request.query?.page) || 1);
        const pageSize = Math.min(100, Math.max(1, Number(request.query?.pageSize) || 25));
        const search = String(request.query?.search || '').toLowerCase();

        let all = await links().find({}, { limit: 1000 });
        if (search) {
          all = all.filter(
            (l) =>
              (l.username || '').toLowerCase().includes(search) ||
              (l.globalName || '').toLowerCase().includes(search) ||
              (l.email || '').toLowerCase().includes(search) ||
              l.discordId.includes(search),
          );
        }
        // Engine-agnostic ordering (collection sort keys differ per engine).
        all.sort((a, b) => String(b.linkedAt || b._createdAt || '').localeCompare(String(a.linkedAt || a._createdAt || '')));

        const total = all.length;
        const pageLinks = all.slice((page - 1) * pageSize, page * pageSize);

        // Decorate the visible page with panel usernames where readable.
        const enriched = [];
        for (const link of pageLinks) {
          let panelUser = null;
          try {
            panelUser = await ctx.auth.findUser({ userId: link.userId });
          } catch {
            /* plugin may lack auth.users later; keep row visible */
          }
          enriched.push({
            ...link,
            panelUsername: panelUser?.username ?? null,
            panelBanned: panelUser?.banned ?? null,
          });
        }

        return {
          success: true,
          total,
          page,
          pageSize,
          links: enriched,
        };
      },
    });

    ctx.registerRoute({
      method: 'DELETE',
      url: '/links/:userId',
      preHandler: requireAdminWrite,
      handler: async (request, reply) => {
        const { userId } = request.params;
        const link = await links().findOne({ userId });
        if (!link) return reply.status(404).send({ success: false, error: 'No link for that user' });
        await links().delete({ userId });
        ctx.emit('discord:account_unlinked', { userId, discordId: link.discordId });
        return { success: true };
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/sync',
      preHandler: requireAdminWrite,
      handler: async () => {
        const settings = await getSettings(ctx);
        const allLinks = await links().find({}, { limit: 500 });
        const summary = await syncAllLinks(ctx, { links: allLinks, settings, log: ctx.logger });
        await ctx.setStorage('lastSync', { at: new Date().toISOString(), ...summary });
        ctx.emit('discord:sync_completed', {
          processed: summary.processed,
          assigned: summary.assigned,
          removed: summary.removed,
          errors: summary.errors,
        });
        return { success: true, summary };
      },
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/status',
      preHandler: requireAdminRead,
      handler: async (request) => {
        const settings = await getSettings(ctx);
        const lastSync = await ctx.getStorage('lastSync');
        const linkCount = await links().count();
        return {
          success: true,
          ready: Boolean(settings.clientId && settings.clientSecret),
          guildConfigured: Boolean(settings.guildId),
          mappingsCount: (settings.roleMappings || []).length,
          linkCount,
          lastSync,
          loginDisabled: settings.loginDisabled,
          redirectUri: `${publicOrigin(request, settings)}/api/plugins/discord-oauth/callback`,
        };
      },
    });

    // Expose for other plugins (e.g. a welcome-bot could check links).
    ctx.exposeApi('getLink', async (params) => links().findOne({ userId: params?.userId }));

    ctx.logger.info('discord-oauth routes registered');
  },

  async onEnable(ctx) {
    const settings = await getSettings(ctx);
    await armSyncTask(ctx, settings);
    ctx.logger.info('discord-oauth enabled');
  },

  async onDisable(ctx) {
    // Host stops registered tasks; nothing extra to release.
    ctx.logger.info('discord-oauth disabled');
  },
};

/**
 * (Re)register the scheduled sync task for the current settings.
 *
 * scheduleTask cannot unregister a previous cron, so each armed closure
 * captures a run token; superseded tasks (schedule changed or sync disabled)
 * see a mismatch and no-op forever.
 */
async function armSyncTask(ctx, settings) {
  if (!settings.syncEnabled) {
    await ctx.setStorage('syncRunToken', null);
    return;
  }
  const token = randomBytes(12).toString('hex');
  await ctx.setStorage('syncRunToken', token);
  ctx.scheduleTask(settings.syncSchedule || '0 * * * *', async () => {
    try {
      const currentToken = await ctx.getStorage('syncRunToken');
      if (currentToken !== token) return; // stale task — superseded/disabled

      const links = await ctx.collection('links').find({}, { limit: 500 });
      const summary = await syncAllLinks(ctx, { links, settings, log: ctx.logger });
      await ctx.setStorage('lastSync', { at: new Date().toISOString(), ...summary });
      ctx.emit('discord:sync_completed', {
        processed: summary.processed,
        assigned: summary.assigned,
        removed: summary.removed,
        errors: summary.errors,
      });
    } catch (err) {
      ctx.logger.error({ error: err.message }, 'discord-oauth scheduled sync failed');
    }
  });
}

export default plugin;
