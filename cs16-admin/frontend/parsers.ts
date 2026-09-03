/**
 * CS 1.6 Admin — HLDS / ReHLDS console parsers.
 * Pure functions shared by the live tab. No DOM, no fetch.
 */

export interface CsPlayer {
  slot: number | null;
  userid: number | null;
  name: string;
  steamId: string;
  frag: number | null;
  time: string | null;
  ping: number | null;
  loss: number | null;
  address: string | null;
  isBot: boolean;
}

export interface CsStatus {
  hostname: string | null;
  map: string | null;
  playersActive: number | null;
  playersMax: number | null;
  players: CsPlayer[];
}

export interface CsChatMessage {
  key: string;
  name: string;
  steamId: string;
  userid: number | null;
  team: 'CT' | 'T' | 'SPEC' | null;
  isTeam: boolean;
  isDead: boolean;
  message: string;
  raw: string;
}

export interface CsConnectionNotice {
  key: string;
  kind: 'connected' | 'disconnected' | 'entered' | 'team-join';
  name: string;
  steamId: string;
  raw: string;
}

export interface CsRoundEvent {
  key: string;
  kind: 'round-start' | 'round-end' | 'round-draw' | 'score' | 'map-loading' | 'map-started' | 'game-commencing' | 'restart';
  round?: number;
  map?: string;
  ctScore?: number;
  tScore?: number;
  winner?: 'CT' | 'T' | null;
  raw: string;
}

const LOG_PREFIX_RE = /^L\s+\d{2}\/\d{2}\/\d{4}\s+-\s+\d{2}:\d{2}:\d{2}:\s*/;
export function stripLogPrefix(line: string): string {
  return line.replace(LOG_PREFIX_RE, '');
}

function cleanPlayerName(raw: string): { name: string; isDead: boolean } {
  let name = raw;
  let isDead = false;
  if (/^\*DEAD\*/i.test(name)) {
    isDead = true;
    name = name.replace(/^\*DEAD\*\s*/i, '');
  }
  name = name
    .replace(/^\((Terrorist|Counter-Terrorist|Spectator|TERRORIST|CT|T)\)\s*/i, '')
    .replace(/\s*\((Terrorist|Counter-Terrorist|Spectator)\)\s*$/i, '')
    .trim();
  return { name: name || raw.trim(), isDead };
}

function teamTagToTeam(tag: string): 'CT' | 'T' | 'SPEC' | null {
  const t = (tag || '').toUpperCase();
  if (!t) return null;
  if (t === 'CT' || t.includes('COUNTER')) return 'CT';
  if (t === 'T' || t.includes('TERRORIST')) return 'T';
  if (t.includes('SPEC')) return 'SPEC';
  return null;
}

// "Name<userid><steamid><teamtag>" say["\_team"] "message"
const SAY_RE = /"(.+?)<(\d+)><([^>]+)><([^>]*)>"\s+(say|say_team)\s+"(.*)"\s*$/;
const IDENTITY_RE = /"(.+?)<(\d+)><([^>]+)><([^>]*)>"/;

export function parseChatLine(line: string, key: string): CsChatMessage | null {
  const body = stripLogPrefix(line);
  if (/\bServer\s+say\s+"/i.test(body)) {
    const m = body.match(/\bServer\s+say\s+"(.*)"\s*$/i);
    if (!m) return null;
    return {
      key, name: 'Server', steamId: '', userid: null,
      team: null, isTeam: false, isDead: false, message: m[1], raw: line,
    };
  }
  const m = body.match(SAY_RE);
  if (!m) return null;
  const [, rawName, useridStr, steamId, teamTag, kind, message] = m;
  const { name, isDead } = cleanPlayerName(rawName);
  return {
    key,
    name,
    steamId: (steamId || '').trim(),
    userid: Number.isFinite(Number(useridStr)) ? Number(useridStr) : null,
    team: teamTagToTeam(teamTag),
    isTeam: kind === 'say_team',
    isDead,
    message,
    raw: line,
  };
}

export function parseConnectionLine(line: string, key: string): CsConnectionNotice | null {
  const body = stripLogPrefix(line);
  const id = body.match(IDENTITY_RE);
  if (!id) {
    // Dropped lines carry the name without an identity block.
    const dropped = body.match(/Dropped\s+"([^"]+)"\s+from\s+server/i);
    if (dropped) {
      return { key, kind: 'disconnected', name: dropped[1], steamId: '', raw: line };
    }
    return null;
  }
  const [, rawName, , steamId] = id;
  const { name } = cleanPlayerName(rawName);
  const lower = body.toLowerCase();
  if (lower.includes('connected, address')) return { key, kind: 'connected', name, steamId, raw: line };
  if (lower.includes('disconnected') || lower.includes('dropped')) {
    return { key, kind: 'disconnected', name, steamId, raw: line };
  }
  if (lower.includes('entered the game')) return { key, kind: 'entered', name, steamId, raw: line };
  if (lower.includes('joined team')) return { key, kind: 'team-join', name, steamId, raw: line };
  return null;
}

const SCORE_RE = /Team\s+"([^"]+)"\s+scored\s+"(\d+)"/i;
const LOADING_MAP_RE = /Loading\s+map\s+"([^"]+)"/i;
const STARTED_MAP_RE = /Started\s+map\s+"([^"]+)"/i;

function normalizeScoreSide(side: string): 'CT' | 'T' | null {
  const s = side.trim().toUpperCase();
  if (s === 'CT' || s.includes('COUNTER')) return 'CT';
  if (s === 'T' || s.includes('TERROR')) return 'T';
  return null;
}

export function parseRoundLine(line: string, key: string): CsRoundEvent | null {
  const body = stripLogPrefix(line);
  if (/World\s+triggered\s+"Round_Start"/i.test(body)) return { key, kind: 'round-start', raw: line };
  if (/World\s+triggered\s+"Round_Draw"/i.test(body)) {
    return { key, kind: 'round-draw', winner: null, raw: line };
  }
  if (/World\s+triggered\s+"Round_End"/i.test(body)) return { key, kind: 'round-end', raw: line };
  if (/World\s+triggered\s+"Game_Commencing"/i.test(body)) return { key, kind: 'game-commencing', raw: line };
  if (/(Round_Restart|Game\s+restarted|Restarting\s+round)/i.test(body)) return { key, kind: 'restart', raw: line };
  const score = body.match(SCORE_RE);
  if (score) {
    const side = normalizeScoreSide(score[1]);
    if (!side) return null;
    const value = Number(score[2]);
    return {
      key, kind: 'score', raw: line,
      ctScore: side === 'CT' ? value : undefined,
      tScore: side === 'T' ? value : undefined,
    };
  }
  if (/CTs_Win/i.test(body)) return { key, kind: 'round-end', winner: 'CT', raw: line };
  if (/Terrorists?_Win/i.test(body)) return { key, kind: 'round-end', winner: 'T', raw: line };
  const loading = body.match(LOADING_MAP_RE);
  if (loading) return { key, kind: 'map-loading', map: loading[1], raw: line };
  const started = body.match(STARTED_MAP_RE);
  if (started) return { key, kind: 'map-started', map: started[1], raw: line };
  return null;
}

const HOSTNAME_RE = /^hostname\s*:\s*(.+)$/i;
const MAP_LINE_RE = /^map\s*:\s*(\S+)/i;
const PLAYERS_LINE_RE = /^players\s*:\s*(\d+)\s+active\s*\((\d+)\s*max\)/i;
// # slot "name" userid steamid frag time ping loss adr
const STATUS_PLAYER_RE = /^#\s+(\d+)\s+"([^"]*)"\s+(\d+)\s+(\S+)(.*)$/;

export function parseStatusBlock(text: string): CsStatus {
  const out: CsStatus = { hostname: null, map: null, playersActive: null, playersMax: null, players: [] };
  const lines = String(text || '').split('\n');
  // Only the last status dump matters — earlier dumps are stale.
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (HOSTNAME_RE.test(lines[i].trim())) start = i;
  }
  const seen = new Set<string>();
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const host = line.match(HOSTNAME_RE);
    if (host) {
      out.hostname = host[1].trim();
      continue;
    }
    const map = line.match(MAP_LINE_RE);
    if (map) {
      out.map = map[1].trim();
      continue;
    }
    const players = line.match(PLAYERS_LINE_RE);
    if (players) {
      out.playersActive = Number(players[1]);
      out.playersMax = Number(players[2]);
      continue;
    }
    const pm = line.match(STATUS_PLAYER_RE);
    if (pm) {
      const slot = Number(pm[1]);
      const name = pm[2];
      const userid = Number(pm[3]);
      const steamId = pm[4];
      const rest = (pm[5] || '').trim().split(/\s+/).filter(Boolean);
      const dedupe = `${userid}:${steamId}:${name}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.players.push({
        slot: Number.isFinite(slot) ? slot : null,
        userid: Number.isFinite(userid) ? userid : null,
        name,
        steamId,
        frag: rest.length > 0 && /^-?\d+$/.test(rest[0]) ? Number(rest[0]) : null,
        time: rest.length > 1 ? rest[1] : null,
        ping: rest.length > 2 && /^\d+$/.test(rest[2]) ? Number(rest[2]) : null,
        loss: rest.length > 3 && /^\d+$/.test(rest[3]) ? Number(rest[3]) : null,
        address: rest.length > 4 ? rest[rest.length - 1] : null,
        isBot: steamId === 'BOT',
      });
    }
  }
  return out;
}

export interface MatchState {
  map: string | null;
  round: number;
  ctScore: number;
  tScore: number;
  history: Array<{ round: number; winner: 'CT' | 'T' | 'Draw'; ctScore: number; tScore: number }>;
}

export function emptyMatchState(): MatchState {
  return { map: null, round: 0, ctScore: 0, tScore: 0, history: [] };
}

/** Fold one round event into match state (pure, testable). */
export function applyRoundEvent(state: MatchState, event: CsRoundEvent): MatchState {
  const next: MatchState = { ...state, history: [...state.history] };
  switch (event.kind) {
    case 'round-start':
      next.round = state.round + 1;
      return next;
    case 'round-end': {
      const winner = event.winner ?? null;
      const round = state.round === 0 ? state.history.length + 1 : state.round;
      next.history = [
        ...state.history,
        {
          round,
          winner: winner ?? 'Draw',
          ctScore: state.ctScore + (winner === 'CT' ? 1 : 0),
          tScore: state.tScore + (winner === 'T' ? 1 : 0),
        },
      ];
      if (winner === 'CT') next.ctScore = state.ctScore + 1;
      if (winner === 'T') next.tScore = state.tScore + 1;
      return next;
    }
    case 'round-draw':
      next.history = [
        ...state.history,
        { round: state.round || state.history.length + 1, winner: 'Draw', ctScore: state.ctScore, tScore: state.tScore },
      ];
      return next;
    case 'score':
      if (typeof event.ctScore === 'number') next.ctScore = event.ctScore;
      if (typeof event.tScore === 'number') next.tScore = event.tScore;
      return next;
    case 'map-loading':
    case 'map-started':
      return { map: event.map ?? state.map, round: 0, ctScore: 0, tScore: 0, history: [] };
    case 'game-commencing':
    case 'restart':
      return { ...state, round: 0, ctScore: 0, tScore: 0, history: [] };
    default:
      return next;
  }
}
