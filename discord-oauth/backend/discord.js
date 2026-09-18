/**
 * Discord REST helpers for the discord-oauth plugin.
 *
 * All calls go through `discordRequest` which enforces a 10s timeout and
 * honors 429 rate-limit responses with a single retry after `retry_after`.
 */

const API_BASE = 'https://discord.com/api/v10';

export class DiscordApiError extends Error {
  constructor(status, message, body) {
    super(message || `Discord API error ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function discordRequest(path, { method = 'GET', token, botToken, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (botToken) headers.Authorization = `Bot ${botToken}`;

  let payload;
  if (form) {
    // Discord's OAuth token endpoint requires x-www-form-urlencoded.
    payload = new URLSearchParams(form).toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: payload,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new DiscordApiError(0, `Discord request failed: ${err.message}`);
    }
    clearTimeout(timer);

    if (res.status === 429 && attempt === 0) {
      const retryMs = Number(res.headers.get('retry-after') || 1) * 1000;
      await new Promise((r) => setTimeout(r, Math.min(retryMs, 5000)));
      continue;
    }

    if (res.status === 204) return null;

    let data = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!res.ok) {
      const message =
        data && typeof data === 'object' && data.error_description
          ? data.error_description
          : data && typeof data === 'object' && data.message
            ? data.message
            : `Discord API error ${res.status}`;
      throw new DiscordApiError(res.status, message, data);
    }
    return data;
  }
  throw new DiscordApiError(429, 'Discord rate limit persisted after retry');
}

/** Exchange an OAuth authorization code for an access token. */
export function exchangeCode({ clientId, clientSecret, code, redirectUri, codeVerifier }) {
  const form = {
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  };
  if (codeVerifier) form.code_verifier = codeVerifier;
  return discordRequest('/oauth2/token', { method: 'POST', form });
}

/** The signed-in Discord user (requires `identify email` scopes). */
export function fetchMe(accessToken) {
  return discordRequest('/users/@me', { token: accessToken });
}

/** The calling user's own guild member record (requires `guilds.members.read`). */
export function fetchMyGuildMember(accessToken, guildId) {
  return discordRequest(`/users/@me/guilds/${guildId}/member`, { token: accessToken });
}

/** Any guild member, looked up by the bot (requires Server Members intent). */
export function fetchGuildMember(botToken, guildId, userId) {
  return discordRequest(`/guilds/${guildId}/members/${userId}`, { botToken });
}

export function fetchGuild(botToken, guildId) {
  return discordRequest(`/guilds/${guildId}?with_counts=true`, { botToken });
}

export function fetchGuildRoles(botToken, guildId) {
  return discordRequest(`/guilds/${guildId}/roles`, { botToken });
}

/** The bot's own user — validates the bot token. */
export function fetchBotUser(botToken) {
  return discordRequest('/users/@me', { botToken });
}

export function avatarUrl(user) {
  if (!user) return null;
  if (user.avatar) {
    const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=128`;
  }
  return `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) % 6n)}.png`;
}

/** Scopes requested at authorize time. */
export const OAUTH_SCOPES = ['identify', 'email', 'guilds', 'guilds.members.read'];
