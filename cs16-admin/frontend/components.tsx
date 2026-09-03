/**
 * CS 1.6 Admin — server tab.
 * Live players (name + SteamID), chat feed, rounds, kick/ban, map and cvars.
 * Reads come from the host console history + live SSE stream; writes go
 * through the validated plugin backend.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Ban, Crosshair, MessageSquare, RefreshCw, Send, ShieldAlert,
  Swords, Trophy, Users,
} from 'lucide-react';
import * as api from './api';
import type { CsAction, CsBan, CsServerInfo, CsSettings } from './api';
import {
  applyRoundEvent, emptyMatchState, parseChatLine, parseConnectionLine,
  parseRoundLine, parseStatusBlock,
  type CsChatMessage, type CsConnectionNotice, type CsPlayer, type CsRoundEvent, type MatchState,
} from './parsers';
import { Badge, Button, Card, CardTitle, FONT_MONO, Input, Skeleton, StatsCard, TEXT_MUTED, Spinner } from './ui';

const HISTORY_LINES = 500;
const MAX_TEXT_BUFFER = 200_000;
const MAX_FEED = 300;

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function timeAgo(iso?: string | null, now?: number): string {
  if (!iso) return 'never';
  const base = now ?? Date.now();
  const s = Math.max(0, (base - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return 'never';
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function splitLines(chunk: string): string[] {
  return String(chunk || '').replace(/\r\n/g, '\n').split('\n');
}

function teamBadge(team: CsChatMessage['team']) {
  if (team === 'CT') return <Badge tone="blue">CT</Badge>;
  if (team === 'T') return <Badge tone="red">T</Badge>;
  if (team === 'SPEC') return <Badge tone="zinc">SPEC</Badge>;
  return null;
}

export function Cs16ServerTab({ serverId }: { serverId: string }) {
  const [info, setInfo] = useState<CsServerInfo | null>(null);
  const [settings, setSettings] = useState<CsSettings | null>(null);
  const [bans, setBans] = useState<CsBan[]>([]);
  const [actions, setActions] = useState<CsAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const [rawText, setRawText] = useState('');
  const [chat, setChat] = useState<CsChatMessage[]>([]);
  const [notices, setNotices] = useState<CsConnectionNotice[]>([]);
  const [roundEvents, setRoundEvents] = useState<CsRoundEvent[]>([]);
  const keyRef = useRef(0);
  const rawRef = useRef('');
  const now = useNow();

  const ingestChunk = useCallback((chunk: string, stream: string) => {
    if (stream === 'stdin' || stream === 'system') return;
    if (!chunk) return;
    rawRef.current = (rawRef.current + chunk).slice(-MAX_TEXT_BUFFER);
    setRawText(rawRef.current);
    const freshChat: CsChatMessage[] = [];
    const freshNotices: CsConnectionNotice[] = [];
    const freshRounds: CsRoundEvent[] = [];
    for (const line of splitLines(chunk)) {
      if (!line.trim()) continue;
      const chatMsg = parseChatLine(line, '');
      if (chatMsg) {
        chatMsg.key = `${Date.now().toString(36)}-${keyRef.current++}`;
        freshChat.push(chatMsg);
        continue;
      }
      const notice = parseConnectionLine(line, '');
      if (notice) {
        notice.key = `${Date.now().toString(36)}-${keyRef.current++}`;
        freshNotices.push(notice);
      }
      const round = parseRoundLine(line, '');
      if (round) {
        round.key = `${Date.now().toString(36)}-${keyRef.current++}`;
        freshRounds.push(round);
      }
    }
    if (freshChat.length) setChat((prev) => [...prev, ...freshChat].slice(-MAX_FEED));
    if (freshNotices.length) setNotices((prev) => [...prev, ...freshNotices].slice(-MAX_FEED));
    if (freshRounds.length) setRoundEvents((prev) => [...prev, ...freshRounds].slice(-MAX_FEED));
  }, []);

  const loadMeta = useCallback(async () => {
    setError(null);
    try {
      const [infoRes, bansRes, actionsRes] = await Promise.all([
        api.fetchInfo(serverId),
        api.fetchBans(serverId).catch(() => [] as CsBan[]),
        api.fetchActions(serverId, 30).catch(() => [] as CsAction[]),
      ]);
      setInfo(infoRes.server);
      setSettings(infoRes.settings);
      setBans(bansRes);
      setActions(actionsRes);
    } catch (e: any) {
      setError(e?.message || 'Failed to load CS 1.6 admin data');
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  // Initial history + meta.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setChat([]);
    setNotices([]);
    setRoundEvents([]);
    rawRef.current = '';
    setRawText('');
    setHistoryError(null);
    void loadMeta();
    api.fetchConsoleHistory(serverId, HISTORY_LINES).then(
      (logs) => {
        if (cancelled) return;
        const combined = logs.map((l) => l.data).join('');
        if (combined) ingestChunk(combined, 'stdout');
      },
      (e: any) => {
        if (!cancelled) setHistoryError(e?.message || 'Console history unavailable');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [serverId, loadMeta, ingestChunk]);

  // Live stream.
  useEffect(() => {
    const unsub = api.subscribeConsole(serverId, (data, stream) => ingestChunk(data, stream), setConnected);
    return unsub;
  }, [serverId, ingestChunk]);

  const status = useMemo(() => parseStatusBlock(rawText), [rawText]);
  const match: MatchState = useMemo(() => {
    let state = emptyMatchState();
    if (status.map) state = { ...state, map: status.map };
    for (const ev of roundEvents) state = applyRoundEvent(state, ev);
    return state;
  }, [roundEvents, status.map]);

  const refreshAll = useCallback(async () => {
    await loadMeta();
    try {
      await api.refreshPlayers(serverId);
    } catch (e: any) {
      setError(e?.message || 'Failed to request status');
    }
  }, [loadMeta, serverId]);

  if (loading && !info) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Header
        info={info}
        connected={connected}
        playersActive={status.playersActive ?? status.players.length}
        playersMax={status.playersMax}
        map={match.map ?? status.map}
        onRefresh={refreshAll}
      />

      {error ? (
        <div className="flex items-center gap-2 rounded-lg border border-red-700/40 bg-red-950/30 px-3 py-2 text-sm text-red-300">
          <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
        </div>
      ) : null}
      {historyError ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-sm text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" /> Live parsing is limited: {historyError} (needs console.read).
        </div>
      ) : null}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatsCard label="Players" value={`${status.playersActive ?? status.players.length}${status.playersMax ? ` / ${status.playersMax}` : ''}`} sub={connected ? 'live stream' : 'last snapshot'} />
        <StatsCard label="Map" value={match.map ?? status.map ?? '—'} sub={info?.status ? `server ${info.status}` : undefined} />
        <StatsCard label="Round" value={match.round > 0 ? String(match.round) : '—'} sub={`CT ${match.ctScore} : ${match.tScore} T`} />
        <StatsCard label="Active bans" value={String(bans.filter((b) => (b.status ?? 'active') === 'active').length)} sub={`${actions.length} recent actions`} />
      </div>

      <PlayersPanel serverId={serverId} players={status.players} useAmx={settings?.useAmx ?? true} onChanged={loadMeta} />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <ChatPanel serverId={serverId} chat={chat} notices={notices} useAmx={settings?.useAmx ?? true} />
        <RoundsPanel match={match} serverId={serverId} useAmx={settings?.useAmx ?? true} />
      </div>

      <BansPanel serverId={serverId} bans={bans} defaultMinutes={settings?.defaultBanMinutes ?? 1440} useAmx={settings?.useAmx ?? true} onChanged={loadMeta} now={now} />

      <ControlsPanel
        serverId={serverId}
        settings={settings}
        actions={actions}
        onSettingsChanged={(s) => setSettings(s)}
        onChanged={loadMeta}
        now={now}
      />
    </div>
  );
}

function Header({
  info, connected, playersActive, playersMax, map, onRefresh,
}: {
  info: CsServerInfo | null;
  connected: boolean;
  playersActive: number;
  playersMax: number | null;
  map: string | null;
  onRefresh: () => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <Crosshair className="h-6 w-6 text-orange-400" /> CS 1.6 Admin
        </h2>
        <p className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>
          {info ? <span className="font-medium text-foreground">{info.name}</span> : 'Server management'}
          {map ? <span style={FONT_MONO as any} className="font-mono"> · {map}</span> : null}
          <span> · {playersActive}{playersMax ? `/${playersMax}` : ''} players</span>
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Badge tone={connected ? 'green' : 'amber'}>{connected ? 'Live' : 'Connecting…'}</Badge>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setRefreshing(true);
            Promise.resolve(onRefresh()).finally(() => setTimeout(() => setRefreshing(false), 1200));
          }}
          disabled={refreshing}
        >
          {refreshing ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh status
        </Button>
      </div>
    </div>
  );
}

function PlayersPanel({
  serverId, players, useAmx, onChanged,
}: {
  serverId: string;
  players: CsPlayer[];
  useAmx: boolean;
  onChanged: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string>('');
  const [reason, setReason] = useState('');
  const [banMinutes, setBanMinutes] = useState('1440');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return players;
    return players.filter(
      (p) => p.name.toLowerCase().includes(q) || p.steamId.toLowerCase().includes(q) || String(p.userid ?? '').includes(q),
    );
  }, [players, query]);

  const selectedPlayer = useMemo(
    () => players.find((p) => (p.userid != null ? `#${p.userid}` : p.name) === selected) ?? null,
    [players, selected],
  );

  const run = useCallback(async (kind: string, fn: () => Promise<void>) => {
    setBusy(kind);
    setNotice(null);
    try {
      await fn();
      await onChanged();
      setNotice('Command sent.');
    } catch (e: any) {
      setNotice(e?.message || 'Command failed');
    } finally {
      setBusy(null);
    }
  }, [onChanged]);

  const kick = (p: CsPlayer) =>
    run(`kick-${p.userid ?? p.name}`, () =>
      api.kickPlayer(serverId, {
        userid: p.userid != null ? `#${p.userid}` : undefined,
        name: p.userid == null ? p.name : undefined,
        steamId: p.steamId,
        reason: reason || undefined,
        useAmx,
      }),
    );

  const ban = (p: CsPlayer) =>
    run(`ban-${p.userid ?? p.name}`, () =>
      api.banPlayer(serverId, {
        steamId: p.steamId,
        name: p.name,
        minutes: Number(banMinutes) || 0,
        reason: reason || undefined,
        useAmx,
      }),
    );

  return (
    <Card>
      <CardTitle>
        <span className="flex items-center gap-2">
          <Users className="h-4 w-4" /> Players ({filtered.length})
        </span>
      </CardTitle>
      <div className="flex flex-col md:flex-row gap-2 mb-3">
        <Input placeholder="Filter by name, SteamID or userid…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Input placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} className="md:max-w-64" />
        <Input
          placeholder="Ban minutes (0 = permanent)"
          value={banMinutes}
          onChange={(e) => setBanMinutes(e.target.value)}
          inputMode="numeric"
          className="md:max-w-48"
        />
      </div>
      {players.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
          No players parsed yet. Press <strong>Refresh status</strong> while the server is running, then watch this
          list populate from the <span style={FONT_MONO as any} className="font-mono">status</span> dump.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--muted-foreground)' }}>
                <th className="px-3 py-2">Player</th>
                <th className="px-3 py-2">SteamID</th>
                <th className="px-3 py-2 hidden sm:table-cell">Userid</th>
                <th className="px-3 py-2 hidden md:table-cell">Frag / Ping</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const key = `${p.userid ?? p.slot ?? p.name}-${p.steamId}`;
                const id = p.userid != null ? `#${p.userid}` : p.name;
                const isSelected = selected === id;
                return (
                  <tr
                    key={key}
                    className={`border-t border-border cursor-pointer ${isSelected ? 'bg-accent/40' : ''}`}
                    onClick={() => setSelected(isSelected ? '' : id)}
                  >
                    <td className="px-3 py-2">
                      <span className="font-medium">{p.name}</span>
                      {p.isBot ? <span className="ml-2"><Badge tone="zinc">BOT</Badge></span> : null}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{p.steamId}</td>
                    <td className="px-3 py-2 hidden sm:table-cell font-mono text-xs">{p.userid != null ? `#${p.userid}` : '—'}</td>
                    <td className="px-3 py-2 hidden md:table-cell text-xs" style={{ color: 'var(--muted-foreground)' }}>
                      {p.frag ?? '—'} / {p.ping ?? '—'}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                        <Button size="xs" variant="outline" disabled={busy != null} onClick={() => kick(p)}>
                          {busy === `kick-${p.userid ?? p.name}` ? <Spinner className="h-3 w-3" /> : null} Kick
                        </Button>
                        <Button size="xs" variant="danger" disabled={busy != null || p.isBot} onClick={() => ban(p)}>
                          {busy === `ban-${p.userid ?? p.name}` ? <Spinner className="h-3 w-3" /> : null} Ban
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {selectedPlayer ? (
        <p className="mt-2 text-xs" style={{ color: 'var(--muted-foreground)' }}>
          Selected <span className="font-mono">{selectedPlayer.name}</span> ({selectedPlayer.steamId}) — the reason
          and ban-minutes fields above apply to the Kick / Ban buttons.
        </p>
      ) : null}
      {notice ? <p className="mt-2 text-xs text-amber-300">{notice}</p> : null}
    </Card>
  );
}

function ChatPanel({
  serverId, chat, notices, useAmx,
}: {
  serverId: string;
  chat: CsChatMessage[];
  notices: CsConnectionNotice[];
  useAmx: boolean;
}) {
  const [message, setMessage] = useState('');
  const [teamOnly, setTeamOnly] = useState(false);
  const [filter, setFilter] = useState('');
  const [showJoins, setShowJoins] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'nearest' });
  }, [chat.length, notices.length]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? chat.filter((c) => c.name.toLowerCase().includes(q) || c.message.toLowerCase().includes(q))
      : chat;
    return filtered.slice(-120);
  }, [chat, filter]);

  const send = async () => {
    const text = message.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.sendSay(serverId, text, { team: teamOnly, useAmx });
      setMessage('');
    } catch (e: any) {
      setError(e?.message || 'Failed to send chat');
    } finally {
      setSending(false);
    }
  };

  return (
    <Card className="flex flex-col min-h-[420px]">
      <CardTitle>
        <span className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4" /> Live chat ({chat.length})
        </span>
      </CardTitle>
      <div className="flex gap-2 mb-2">
        <Input placeholder="Filter chat…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Button size="sm" variant={showJoins ? 'default' : 'outline'} onClick={() => setShowJoins((v) => !v)}>
          Joins
        </Button>
      </div>
      <div className="flex-1 min-h-[240px] max-h-[360px] overflow-y-auto space-y-1.5 rounded-md border border-border bg-black/20 p-2">
        {visible.length === 0 && (!showJoins || notices.length === 0) ? (
          <p className="text-xs p-2" style={{ color: 'var(--muted-foreground)' }}>
            No chat yet. Player <span className="font-mono">say</span> and <span className="font-mono">say_team</span>{' '}
            lines appear here live. Use the box below to write into the game as admin.
          </p>
        ) : null}
        {visible.map((c) => (
          <div key={c.key} className="text-[13px] leading-snug">
            <span className="inline-flex items-center gap-1 mr-1.5">
              {teamBadge(c.team)}
              {c.isTeam ? <Badge tone="purple">TEAM</Badge> : null}
              {c.isDead ? <Badge tone="zinc">DEAD</Badge> : null}
            </span>
            <span className="font-semibold">{c.name}</span>
            <span className="font-mono text-[11px] ml-1" style={{ color: 'var(--muted-foreground)' }}>{c.steamId}</span>
            <span>: {c.message}</span>
          </div>
        ))}
        {showJoins
          ? notices.slice(-20).map((n) => (
            <div key={n.key} className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
              {n.kind === 'connected' ? `→ ${n.name} connected` : null}
              {n.kind === 'disconnected' ? `← ${n.name} left` : null}
              {n.kind === 'entered' ? `• ${n.name} entered the game` : null}
              {n.kind === 'team-join' ? `• ${n.name} joined a team` : null}
            </div>
          ))
          : null}
        <div ref={bottomRef} />
      </div>
      <div className="flex gap-2 mt-3">
        <Input
          placeholder={useAmx ? 'Admin message (amx_say)…' : 'Admin message (say)…'}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void send();
          }}
          maxLength={256}
        />
        <Button size="sm" variant={teamOnly ? 'default' : 'outline'} onClick={() => setTeamOnly((v) => !v)} title="Send as team chat">
          Team
        </Button>
        <Button size="sm" onClick={() => void send()} disabled={sending || !message.trim()}>
          {sending ? <Spinner /> : <Send className="h-3.5 w-3.5" />} Say
        </Button>
      </div>
      {error ? <p className="mt-2 text-xs text-red-300">{error}</p> : null}
      <p className="mt-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
        Live feed · {useAmx ? 'AMX mode' : 'vanilla say'}
      </p>
    </Card>
  );
}

function RoundsPanel({ match, serverId, useAmx }: { match: MatchState; serverId: string; useAmx: boolean }) {
  const [map, setMap] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (kind: string, fn: () => Promise<void>) => {
    setBusy(kind);
    setNotice(null);
    try {
      await fn();
      setNotice('Command sent.');
      setMap('');
    } catch (e: any) {
      setNotice(e?.message || 'Command failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="min-h-[420px]">
      <CardTitle>
        <span className="flex items-center gap-2">
          <Trophy className="h-4 w-4" /> Rounds and map
        </span>
      </CardTitle>
      <div className="flex items-center gap-6 mb-3">
        <div className="text-center">
          <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--muted-foreground)' }}>CT</div>
          <div className="text-3xl font-bold text-sky-300">{match.ctScore}</div>
        </div>
        <div className="text-center">
          <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--muted-foreground)' }}>Round</div>
          <div className="text-3xl font-bold">{match.round || '—'}</div>
        </div>
        <div className="text-center">
          <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--muted-foreground)' }}>T</div>
          <div className="text-3xl font-bold text-red-300">{match.tScore}</div>
        </div>
        <div className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
          {match.map ? <span>Map <span className="font-mono text-foreground">{match.map}</span></span> : 'Map unknown yet'}
        </div>
      </div>
      {match.history.length === 0 ? (
        <p className="text-xs mb-3" style={{ color: 'var(--muted-foreground)' }}>
          Round history builds from <span className="font-mono">Round_Start</span> / <span className="font-mono">Round_End</span>{' '}
          and <span className="font-mono">Team scored</span> lines. Scores also sync from status-driven score lines.
        </p>
      ) : (
        <div className="mb-3 max-h-40 overflow-y-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left uppercase tracking-wide" style={{ color: 'var(--muted-foreground)' }}>
                <th className="px-2 py-1">Round</th>
                <th className="px-2 py-1">Winner</th>
                <th className="px-2 py-1">CT : T</th>
              </tr>
            </thead>
            <tbody>
              {[...match.history].slice(-12).reverse().map((h) => (
                <tr key={h.round} className="border-t border-border">
                  <td className="px-2 py-1 font-mono">{h.round}</td>
                  <td className="px-2 py-1">
                    {h.winner === 'CT' ? <Badge tone="blue">CT</Badge> : h.winner === 'T' ? <Badge tone="red">T</Badge> : <Badge tone="zinc">Draw</Badge>}
                  </td>
                  <td className="px-2 py-1 font-mono">{h.ctScore} : {h.tScore}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex gap-2">
        <Input placeholder="Map name, e.g. de_dust2" value={map} onChange={(e) => setMap(e.target.value)} />
        <Button
          size="sm"
          disabled={busy != null || !map.trim()}
          onClick={() => void run('map', () => api.changeMap(serverId, map.trim(), useAmx))}
        >
          {busy === 'map' ? <Spinner /> : null} Change map
        </Button>
        <Button size="sm" variant="outline" disabled={busy != null} onClick={() => void run('restart', () => api.restartRounds(serverId, 1))}>
          {busy === 'restart' ? <Spinner /> : <Swords className="h-3.5 w-3.5" />} Restart
        </Button>
      </div>
      {notice ? <p className="mt-2 text-xs text-amber-300">{notice}</p> : null}
    </Card>
  );
}

function BansPanel({
  serverId, bans, defaultMinutes, useAmx, onChanged, now,
}: {
  serverId: string;
  bans: CsBan[];
  defaultMinutes: number;
  useAmx: boolean;
  onChanged: () => void;
  now: number;
}) {
  const [steamId, setSteamId] = useState('');
  const [name, setName] = useState('');
  const [minutes, setMinutes] = useState(String(defaultMinutes || 1440));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMinutes(String(defaultMinutes || 1440));
  }, [defaultMinutes]);

  const submit = async () => {
    if (!steamId.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.banPlayer(serverId, {
        steamId: steamId.trim(), name: name.trim() || undefined,
        minutes: Number(minutes) || 0, reason: reason.trim() || undefined, useAmx,
      });
      setSteamId('');
      setName('');
      setReason('');
      await onChanged();
    } catch (e: any) {
      setError(e?.message || 'Ban failed');
    } finally {
      setBusy(false);
    }
  };

  const unban = async (ban: CsBan) => {
    setBusy(true);
    setError(null);
    try {
      await api.unbanPlayer(serverId, ban.steamId, useAmx);
      await onChanged();
    } catch (e: any) {
      setError(e?.message || 'Unban failed');
    } finally {
      setBusy(false);
    }
  };

  const active = bans.filter((b) => (b.status ?? 'active') === 'active');

  return (
    <Card>
      <CardTitle>
        <span className="flex items-center gap-2">
          <Ban className="h-4 w-4" /> Bans ({active.length} active)
        </span>
      </CardTitle>
      <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_140px_1fr_auto] gap-2 mb-3">
        <Input placeholder="SteamID, e.g. STEAM_0:1:12345" value={steamId} onChange={(e) => setSteamId(e.target.value)} style={FONT_MONO as any} className="font-mono" />
        <Input placeholder="Player name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <Input placeholder="Minutes (0 = permanent)" value={minutes} onChange={(e) => setMinutes(e.target.value)} inputMode="numeric" />
        <Input placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <Button size="sm" onClick={() => void submit()} disabled={busy || !steamId.trim()}>
          {busy ? <Spinner /> : <ShieldAlert className="h-3.5 w-3.5" />} Ban
        </Button>
      </div>
      {error ? <p className="mb-2 text-xs text-red-300">{error}</p> : null}
      {bans.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
          No bans recorded by this tab yet. Bans issued here are enforced with{' '}
          <span className="font-mono">banid</span> / <span className="font-mono">amx_ban</span> and stored so they
          survive restarts.
        </p>
      ) : (
        <div className="max-h-64 overflow-y-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--muted-foreground)' }}>
                <th className="px-3 py-2">SteamID / Name</th>
                <th className="px-3 py-2 hidden sm:table-cell">Length</th>
                <th className="px-3 py-2 hidden md:table-cell">When</th>
                <th className="px-3 py-2 text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {bans.slice(0, 50).map((b) => {
                const key = b.id ?? b._id ?? `${b.steamId}-${b.createdAt}`;
                const isActive = (b.status ?? 'active') === 'active';
                return (
                  <tr key={key} className="border-t border-border">
                    <td className="px-3 py-2">
                      <div className="font-mono text-xs">{b.steamId}</div>
                      <div className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                        {b.name ?? '—'}{b.reason ? ` · ${b.reason}` : ''}
                      </div>
                    </td>
                    <td className="px-3 py-2 hidden sm:table-cell text-xs">
                      {b.minutes === 0 ? 'permanent' : `${b.minutes}m`}
                    </td>
                    <td className="px-3 py-2 hidden md:table-cell text-xs" style={{ color: 'var(--muted-foreground)' }}>
                      {timeAgo(b.createdAt, now)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {isActive ? (
                        <Button size="xs" variant="outline" disabled={busy} onClick={() => void unban(b)}>
                          Unban
                        </Button>
                      ) : (
                        <Badge tone="zinc">{b.status}</Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const CVAR_PRESETS: Array<{ cvar: string; label: string; placeholder: string }> = [
  { cvar: 'mp_timelimit', label: 'Time limit (min)', placeholder: '20' },
  { cvar: 'mp_maxrounds', label: 'Max rounds', placeholder: '0' },
  { cvar: 'mp_winlimit', label: 'Win limit', placeholder: '0' },
  { cvar: 'mp_freezetime', label: 'Freeze time (s)', placeholder: '6' },
  { cvar: 'mp_roundtime', label: 'Round time (min)', placeholder: '2.5' },
  { cvar: 'sv_password', label: 'Server password', placeholder: 'empty = public' },
  { cvar: 'hostname', label: 'Hostname', placeholder: 'My CS 1.6 Server' },
  { cvar: 'sv_alltalk', label: 'Alltalk (0/1)', placeholder: '0' },
];

function ControlsPanel({
  serverId, settings, actions, onSettingsChanged, onChanged, now,
}: {
  serverId: string;
  settings: CsSettings | null;
  actions: CsAction[];
  onSettingsChanged: (s: CsSettings) => void;
  onChanged: () => void;
  now: number;
}) {
  const [cvarValues, setCvarValues] = useState<Record<string, string>>({});
  const [cvarBusy, setCvarBusy] = useState<string | null>(null);
  const [amxTarget, setAmxTarget] = useState('');
  const [amxBusy, setAmxBusy] = useState<string | null>(null);
  const [raw, setRaw] = useState('');
  const [rawBusy, setRawBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [banFiles, setBanFiles] = useState<Record<string, string> | null>(null);
  const [banFilesOpen, setBanFilesOpen] = useState(false);

  const setCvar = async (cvar: string) => {
    const value = (cvarValues[cvar] ?? '').trim();
    if (!value) return;
    setCvarBusy(cvar);
    setFeedback(null);
    try {
      await api.setCvar(serverId, cvar, value);
      setFeedback(`${cvar} sent.`);
      await onChanged();
    } catch (e: any) {
      setFeedback(e?.message || 'Cvar failed');
    } finally {
      setCvarBusy(null);
    }
  };

  const amx = async (action: string) => {
    if (!amxTarget.trim()) {
      setFeedback('AMX needs a target (#userid or name).');
      return;
    }
    setAmxBusy(action);
    setFeedback(null);
    try {
      await api.amxAction(serverId, action, amxTarget.trim());
      setFeedback(`amx_${action} sent.`);
      await onChanged();
    } catch (e: any) {
      setFeedback(e?.message || 'AMX command failed');
    } finally {
      setAmxBusy(null);
    }
  };

  const sendRaw = async () => {
    if (!raw.trim() || rawBusy) return;
    setRawBusy(true);
    setFeedback(null);
    try {
      await api.sendRawCommand(serverId, raw.trim());
      setFeedback('Command sent.');
      setRaw('');
      await onChanged();
    } catch (e: any) {
      setFeedback(e?.message || 'Command failed');
    } finally {
      setRawBusy(false);
    }
  };

  const toggleAmx = async () => {
    if (!settings) return;
    try {
      const next = await api.updateSettings(serverId, { useAmx: !settings.useAmx });
      onSettingsChanged(next);
    } catch (e: any) {
      setFeedback(e?.message || 'Failed to save settings');
    }
  };

  const loadBanFiles = async () => {
    setBanFilesOpen((v) => !v);
    if (banFiles) return;
    try {
      const res = await api.fetchBanFiles(serverId);
      setBanFiles(res.available ? res.files : { 'banned.cfg': '(file tunnel unavailable)' });
    } catch (e: any) {
      setBanFiles({ error: e?.message || 'Failed to load ban files' });
    }
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      <Card>
        <CardTitle>Match settings</CardTitle>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
          {CVAR_PRESETS.map((preset) => (
            <div key={preset.cvar} className="flex gap-1.5">
              <Input
                placeholder={`${preset.label} (${preset.cvar})`}
                value={cvarValues[preset.cvar] ?? ''}
                onChange={(e) => setCvarValues((prev) => ({ ...prev, [preset.cvar]: e.target.value }))}
                title={preset.cvar}
              />
              <Button size="sm" variant="outline" disabled={cvarBusy != null} onClick={() => void setCvar(preset.cvar)}>
                {cvarBusy === preset.cvar ? <Spinner /> : 'Set'}
              </Button>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={settings?.useAmx ? 'green' : 'zinc'}>{settings?.useAmx ? 'AMX mode' : 'Vanilla mode'}</Badge>
          <Button size="sm" variant="outline" onClick={() => void toggleAmx()}>
            Use {settings?.useAmx ? 'vanilla' : 'AMX'} commands
          </Button>
          <Badge tone="zinc">{settings?.defaultBanMinutes ?? 1440} min default ban</Badge>
        </div>
        {feedback ? <p className="mt-2 text-xs text-amber-300">{feedback}</p> : null}
      </Card>

      <Card>
        <CardTitle>Quick AMX and console</CardTitle>
        <div className="flex gap-2 mb-2">
          <Input placeholder="Target #userid or name" value={amxTarget} onChange={(e) => setAmxTarget(e.target.value)} />
        </div>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {['slap', 'slay', 'gag', 'ungag', 'mute', 'unmute'].map((action) => (
            <Button key={action} size="xs" variant="outline" disabled={amxBusy != null} onClick={() => void amx(action)}>
              {amxBusy === action ? <Spinner className="h-3 w-3" /> : null} amx_{action}
            </Button>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            placeholder='Validated command, e.g. status, say hello, mp_timelimit 20'
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void sendRaw();
            }}
            className="font-mono"
          />
          <Button size="sm" onClick={() => void sendRaw()} disabled={rawBusy || !raw.trim()}>
            {rawBusy ? <Spinner /> : <Send className="h-3.5 w-3.5" />} Send
          </Button>
        </div>
        <div className="mt-3">
          <Button size="sm" variant="ghost" onClick={() => void loadBanFiles()}>
            {banFilesOpen ? 'Hide' : 'Show'} ban files (banned.cfg / listip.cfg)
          </Button>
          {banFilesOpen && banFiles ? (
            <div className="mt-2 space-y-2 max-h-48 overflow-y-auto">
              {Object.entries(banFiles).map(([path, content]) => (
                <div key={path}>
                  <div className="font-mono text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{path}</div>
                  <pre className="whitespace-pre-wrap break-all rounded bg-black/30 p-2 text-[11px] font-mono max-h-32 overflow-y-auto">
                    {content || '(empty)'}
                  </pre>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </Card>

      <Card className="xl:col-span-2">
        <CardTitle>Recent admin actions</CardTitle>
        {actions.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
            Nothing recorded yet. Kicks, bans, map changes and raw commands from this tab show up here.
          </p>
        ) : (
          <div className="max-h-56 overflow-y-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left uppercase tracking-wide" style={{ color: 'var(--muted-foreground)' }}>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">Command</th>
                  <th className="px-3 py-2 hidden sm:table-cell">Target</th>
                  <th className="px-3 py-2 hidden md:table-cell">When</th>
                </tr>
              </thead>
              <tbody>
                {actions.slice(0, 30).map((a) => (
                  <tr key={a.id ?? a._id ?? `${a.command}-${a.createdAt}`} className="border-t border-border">
                    <td className="px-3 py-1.5"><Badge tone="zinc">{a.action}</Badge></td>
                    <td className="px-3 py-1.5 font-mono">{a.command}</td>
                    <td className="px-3 py-1.5 hidden sm:table-cell font-mono">{a.target ?? '—'}</td>
                    <td className="px-3 py-1.5 hidden md:table-cell" style={{ color: 'var(--muted-foreground)' }}>
                      {timeAgo(a.createdAt, now)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
