/**
 * CS 1.6 Admin — command builders and validation.
 * Pure functions (no ctx) so they can be unit-tested and reused.
 */

export const MAX_COMMAND_LENGTH = 1024;
export const MAX_MESSAGE_LENGTH = 256;
export const MAX_REASON_LENGTH = 128;
export const MAX_MAP_LENGTH = 64;

// First token allowlist for the raw-command box. Everything the tab sends
// (including builders below) must start with one of these.
export const ALLOWED_COMMANDS = new Set([
  'status',
  'say',
  'say_team',
  'amx_say',
  'amx_chat',
  'amx_tsay',
  'amx_csay',
  'kick',
  'amx_kick',
  'banid',
  'amx_ban',
  'amx_addban',
  'removeid',
  'amx_unban',
  'writeid',
  'writeip',
  'listid',
  'listip',
  'changelevel',
  'amx_map',
  'amx_voteMap',
  'sv_restart',
  'sv_restartround',
  'amx_pause',
  'amx_slap',
  'amx_slay',
  'amx_gag',
  'amx_ungag',
  'amx_mute',
  'amx_unmute',
  'amx_kickmenu',
  'amx_banmenu',
  'mp_timelimit',
  'mp_maxrounds',
  'mp_winlimit',
  'mp_freezetime',
  'mp_roundtime',
  'mp_buytime',
  'mp_startmoney',
  'mp_c4timer',
  'mp_friendlyfire',
  'mp_autoteambalance',
  'mp_limitteams',
  'mp_tkpunish',
  'mp_hostagepenalty',
  'mp_chattime',
  'mp_logmessages',
  'sv_password',
  'sv_voiceenable',
  'sv_alltalk',
  'hostname',
  'pausable',
]);

// Cvars the tab may set through the dedicated cvar endpoint.
export const ALLOWED_CVARS = new Set([
  'mp_timelimit',
  'mp_maxrounds',
  'mp_winlimit',
  'mp_freezetime',
  'mp_roundtime',
  'mp_buytime',
  'mp_startmoney',
  'mp_c4timer',
  'mp_friendlyfire',
  'mp_autoteambalance',
  'mp_limitteams',
  'mp_tkpunish',
  'mp_hostagepenalty',
  'mp_chattime',
  'mp_logmessages',
  'sv_password',
  'sv_voiceenable',
  'sv_alltalk',
  'hostname',
  'pausable',
]);

export const STEAM_ID_RE = /^(STEAM_[0-5]:[01]:\d+|VALVE_[0-5]:[01]:\d+|BOT)$/;
export const USERID_RE = /^#?\d{1,6}$/;
export const MAP_RE = /^[A-Za-z0-9_\-]{1,64}$/;

function assertLength(value, max, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  if (!value.trim()) throw new Error(`${label} is required`);
  if (value.length > max) throw new Error(`${label} exceeds ${max} characters`);
}

function hasShellMeta(value) {
  return /[\r\n;`|&$<>]/.test(value) || /\$\(/.test(value);
}

export function firstToken(command) {
  return String(command || '').trim().split(/\s+/)[0] || '';
}

/** Validate a fully-built console command before it is sent. */
export function validateCommand(command) {
  assertLength(command, MAX_COMMAND_LENGTH, 'command');
  if (hasShellMeta(command)) throw new Error('command contains disallowed characters');
  const token = firstToken(command);
  if (!ALLOWED_COMMANDS.has(token)) throw new Error(`command not allowed: ${token || '(empty)'}`);
  return String(command).trim();
}

export function quoteName(name) {
  assertLength(name, 48, 'name');
  if (/[\r\n";]/.test(name)) throw new Error('name contains disallowed characters');
  return `"${name.replace(/"/g, '')}"`;
}

export function normalizeUserid(input) {
  const raw = String(input || '').trim();
  if (!USERID_RE.test(raw)) throw new Error('userid must be numeric (e.g. 5 or #5)');
  return raw.startsWith('#') ? raw : `#${raw}`;
}

export function normalizeSteamId(input) {
  const raw = String(input || '').trim().toUpperCase();
  if (!STEAM_ID_RE.test(raw)) throw new Error('invalid SteamID (expected STEAM_X:Y:Z)');
  if (raw === 'STEAM_ID_PENDING') throw new Error('SteamID is still pending for this player');
  return raw;
}

export function normalizeMinutes(input, fallback = 1440) {
  if (input === undefined || input === null || input === '') return fallback;
  const n = Number(input);
  if (!Number.isFinite(n) || n < 0 || n > 525600) {
    throw new Error('minutes must be a number between 0 (permanent) and 525600');
  }
  return Math.floor(n);
}

export function normalizeMap(input) {
  const raw = String(input || '').trim();
  if (!MAP_RE.test(raw)) throw new Error('invalid map name (letters, numbers, _ and - only)');
  return raw;
}

export function buildSay(message, { team = false, useAmx = false } = {}) {
  assertLength(message, MAX_MESSAGE_LENGTH, 'message');
  if (/[\r\n"]/.test(message) && !useAmx) throw new Error('message contains disallowed characters');
  const clean = message.replace(/[\r\n]/g, ' ').trim();
  if (!clean) throw new Error('message is required');
  if (useAmx) return `amx_say ${clean}`;
  return team ? `say_team ${clean}` : `say ${clean}`;
}

export function buildStatus() {
  return 'status';
}

export function buildKick({ userid, name, reason = '', useAmx = false } = {}) {
  const cleanReason = String(reason || '').replace(/[\r\n;"]/g, ' ').trim().slice(0, MAX_REASON_LENGTH);
  if (useAmx) {
    const target = userid ? normalizeUserid(userid) : quoteName(name || '');
    return cleanReason ? `amx_kick ${target} ${cleanReason}` : `amx_kick ${target}`;
  }
  if (userid) return `kick ${normalizeUserid(userid)}${cleanReason ? ` ${cleanReason}` : ''}`;
  if (!name) throw new Error('kick needs a userid or a name');
  return `kick ${quoteName(name)}${cleanReason ? ` ${cleanReason}` : ''}`;
}

export function buildBan({ steamId, name = '', minutes = 1440, reason = '', useAmx = false } = {}) {
  const id = normalizeSteamId(steamId);
  const mins = normalizeMinutes(minutes, 1440);
  const cleanReason = String(reason || '').replace(/[\r\n;"]/g, ' ').trim().slice(0, MAX_REASON_LENGTH);
  if (useAmx) {
    const base = `amx_ban ${mins} ${id}`;
    return cleanReason ? `${base} ${cleanReason}` : base;
  }
  // Vanilla: banid <minutes> <authid> [kick]
  return `banid ${mins} ${id} kick`;
}

export function buildUnban({ steamId, useAmx = false } = {}) {
  const id = normalizeSteamId(steamId);
  return useAmx ? `amx_unban ${id}` : `removeid ${id}`;
}

export function buildMap(map, { useAmx = false } = {}) {
  const clean = normalizeMap(map);
  return useAmx ? `amx_map ${clean}` : `changelevel ${clean}`;
}

export function buildRestart(seconds = 1) {
  const n = Number(seconds);
  const clean = Number.isFinite(n) ? Math.min(60, Math.max(1, Math.floor(n))) : 1;
  return `sv_restart ${clean}`;
}

export function buildCvar(cvar, value) {
  if (!ALLOWED_CVARS.has(String(cvar))) throw new Error(`cvar not allowed: ${cvar}`);
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('cvar value is required');
  if (raw.length > 128) throw new Error('cvar value exceeds 128 characters');
  if (/[\r\n;`|&$<>]/.test(raw)) throw new Error('cvar value contains disallowed characters');
  return `${cvar} ${raw}`;
}

export function buildAmxAction(action, target, extra = '') {
  const allowed = new Set(['slap', 'slay', 'gag', 'ungag', 'mute', 'unmute']);
  if (!allowed.has(action)) throw new Error(`amx action not allowed: ${action}`);
  const cleanTarget = USERID_RE.test(String(target || '').trim())
    ? normalizeUserid(target)
    : quoteName(String(target || ''));
  const cleanExtra = String(extra || '').replace(/[\r\n;"]/g, ' ').trim().slice(0, 64);
  return cleanExtra ? `amx_${action} ${cleanTarget} ${cleanExtra}` : `amx_${action} ${cleanTarget}`;
}
