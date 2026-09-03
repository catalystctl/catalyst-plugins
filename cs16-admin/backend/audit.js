/**
 * CS 1.6 Admin — audit-log helpers.
 * Pure functions (no ctx) so they can be unit-tested.
 */

export const MAX_AUDIT_PER_SERVER = 1000;
export const MAX_AUDIT_PAGE_SIZE = 100;

/** Action types the tab can record (used for the filter dropdown). */
export const KNOWN_ACTIONS = [
  'command',
  'say',
  'kick',
  'ban',
  'unban',
  'map',
  'restart',
  'cvar',
  'amx_slap',
  'amx_slay',
  'amx_gag',
  'amx_ungag',
  'amx_mute',
  'amx_unmute',
  'refresh-players',
  'settings',
  'rcon-test',
];

/**
 * Filter audit docs by actor, action type, free text and date range.
 * Dates are `YYYY-MM-DD` (inclusive on both ends); createdAt is ISO.
 */
export function applyActionFilters(docs, filters = {}) {
  const user = String(filters.user || '').trim();
  const action = String(filters.action || '').trim();
  const query = String(filters.search || '').trim().toLowerCase();
  const fromMs = filters.from ? Date.parse(`${filters.from}T00:00:00.000Z`) : NaN;
  const toMs = filters.to ? Date.parse(`${filters.to}T23:59:59.999Z`) : NaN;

  return (Array.isArray(docs) ? docs : []).filter((d) => {
    if (!d || typeof d !== 'object') return false;
    if (user && d.createdBy !== user) return false;
    if (action && d.action !== action) return false;
    if (query) {
      const hay = [d.action, d.command, d.target, d.detail, d.createdByName, d.createdBy]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(query)) return false;
    }
    if (Number.isFinite(fromMs) || Number.isFinite(toMs)) {
      const t = Date.parse(d.createdAt);
      if (!Number.isFinite(t)) return false;
      if (Number.isFinite(fromMs) && t < fromMs) return false;
      if (Number.isFinite(toMs) && t > toMs) return false;
    }
    return true;
  });
}

export function paginateActions(docs, page = 1, pageSize = 20) {
  const list = Array.isArray(docs) ? docs : [];
  const p = Math.max(1, Number(page) || 1);
  const ps = Math.min(MAX_AUDIT_PAGE_SIZE, Math.max(1, Number(pageSize) || 20));
  return {
    items: list.slice((p - 1) * ps, p * ps),
    total: list.length,
    page: p,
    pageSize: ps,
  };
}

/** Distinct actors across docs for the "who did something" filter. */
export function distinctActors(docs) {
  const map = new Map();
  for (const d of Array.isArray(docs) ? docs : []) {
    if (!d || !d.createdBy || map.has(d.createdBy)) continue;
    map.set(d.createdBy, d.createdByName || d.createdBy);
  }
  return [...map.entries()].map(([id, name]) => ({ id, name }));
}

/** Oldest-first list trimmed to the retention cap (returns docs to delete). */
export function overRetentionOldestFirst(docs, cap = MAX_AUDIT_PER_SERVER) {
  const list = Array.isArray(docs) ? docs : [];
  if (list.length <= cap) return [];
  return [...list]
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
    .slice(0, list.length - cap);
}

export function actionsToCsv(rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['time,user,user_id,action,target,command,detail'];
  for (const r of Array.isArray(rows) ? rows : []) {
    lines.push(
      [r.createdAt, r.createdByName || r.createdBy, r.createdBy, r.action, r.target, r.command, r.detail]
        .map(esc)
        .join(','),
    );
  }
  return lines.join('\n');
}
