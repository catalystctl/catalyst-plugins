/**
 * CS 1.6 Admin — typed API client (plugin backend) plus host console helpers.
 */

import { createPluginApi } from '@catalyst/plugin-sdk/frontend';

const api = createPluginApi('cs16-admin');

export interface CsServerInfo {
  id: string;
  name: string;
  uuid: string;
  status: string;
  nodeId: string;
  primaryIp?: string | null;
  primaryPort?: number | null;
}

export interface CsSettings {
  serverId: string;
  useAmx: boolean;
  defaultBanMinutes: number;
  transport: 'auto' | 'rcon' | 'stdin';
  rconHost: string;
  rconPort: number;
  /** True when an RCON password is stored. The secret itself is never returned. */
  rconConfigured: boolean;
}

export interface CsTransport {
  transport: 'auto' | 'rcon' | 'stdin';
  rcon: {
    available: boolean;
    reason: string | null;
    source: 'manual' | 'server.cfg' | null;
    host: string | null;
    port: number | null;
  };
}

export interface CsRefreshResult {
  sent: string;
  transport: 'rcon' | 'stdin';
  /** Present when the dump came back over RCON — parse immediately. */
  status?: string | null;
}

export interface CsBan {
  id?: string;
  _id?: string;
  serverId: string;
  name?: string | null;
  steamId: string;
  minutes: number;
  reason?: string | null;
  status?: string;
  createdAt?: string;
  createdBy?: string | null;
}

export interface CsAction {
  id?: string;
  _id?: string;
  serverId: string;
  action: string;
  command: string;
  target?: string | null;
  detail?: string | null;
  createdAt?: string;
  createdBy?: string | null;
  createdByName?: string | null;
}

export interface CsActionFilters {
  user?: string;
  action?: string;
  search?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface CsAuditPage {
  actions: CsAction[];
  total: number;
  page: number;
  pageSize: number;
  users: Array<{ id: string; name: string }>;
}

async function unwrap<T>(promise: Promise<any>, key?: string): Promise<T> {
  const res: any = await promise;
  if (res && typeof res === 'object' && 'success' in res && res.success === false) {
    throw new Error(res.error || 'request failed');
  }
  if (key && res && typeof res === 'object' && key in res) return res[key] as T;
  if (res && typeof res === 'object' && 'data' in res && key === undefined) return res.data as T;
  return res as T;
}

export async function fetchInfo(serverId: string): Promise<{ server: CsServerInfo; settings: CsSettings; activeBans: number; actionCount: number }> {
  return unwrap(api.get(`/servers/${encodeURIComponent(serverId)}/info`));
}

export async function fetchSettings(serverId: string): Promise<CsSettings> {
  const res = await unwrap<{ settings: CsSettings }>(api.get(`/servers/${encodeURIComponent(serverId)}/settings`));
  return (res as any).settings ?? (res as any);
}

export async function updateSettings(serverId: string, patch: Partial<CsSettings>): Promise<CsSettings> {
  const res = await unwrap<{ settings: CsSettings }>(
    api.put(`/servers/${encodeURIComponent(serverId)}/settings`, patch),
  );
  return (res as any).settings ?? (res as any);
}

export async function refreshPlayers(serverId: string): Promise<CsRefreshResult> {
  const res: any = await unwrap<any>(api.post(`/servers/${encodeURIComponent(serverId)}/refresh-players`, {}));
  return { sent: res.sent, transport: res.transport ?? 'stdin', status: res.status ?? null };
}

export async function fetchTransport(serverId: string): Promise<CsTransport> {
  return unwrap(api.get(`/servers/${encodeURIComponent(serverId)}/transport`));
}

export async function testRcon(serverId: string): Promise<{ host: string; port: number; source: string; latencyMs: number; output: string }> {
  return unwrap(api.post(`/servers/${encodeURIComponent(serverId)}/rcon-test`, {}));
}

export interface CsSendResult {
  sent: string;
  transport: 'rcon' | 'stdin';
}

async function sendResult(promise: Promise<any>): Promise<CsSendResult> {
  const res: any = await unwrap<any>(promise);
  return { sent: res.sent, transport: res.transport ?? 'stdin' };
}

export async function sendRawCommand(serverId: string, command: string): Promise<CsSendResult> {
  return sendResult(api.post(`/servers/${encodeURIComponent(serverId)}/command`, { command }));
}

export async function sendSay(serverId: string, message: string, opts: { team?: boolean; useAmx?: boolean } = {}): Promise<CsSendResult> {
  return sendResult(api.post(`/servers/${encodeURIComponent(serverId)}/say`, { message, ...opts }));
}

export async function kickPlayer(serverId: string, payload: { userid?: string; name?: string; steamId?: string; reason?: string; useAmx?: boolean }): Promise<CsSendResult> {
  return sendResult(api.post(`/servers/${encodeURIComponent(serverId)}/kick`, payload));
}

export async function banPlayer(serverId: string, payload: { steamId: string; name?: string; minutes?: number; reason?: string; useAmx?: boolean }): Promise<CsSendResult> {
  return sendResult(api.post(`/servers/${encodeURIComponent(serverId)}/ban`, payload));
}

export async function unbanPlayer(serverId: string, steamId: string, useAmx?: boolean): Promise<CsSendResult> {
  return sendResult(api.post(`/servers/${encodeURIComponent(serverId)}/unban`, { steamId, useAmx }));
}

export async function fetchBans(serverId: string): Promise<CsBan[]> {
  const res: any = await unwrap<any>(api.get(`/servers/${encodeURIComponent(serverId)}/bans`));
  return res.bans ?? [];
}

export async function changeMap(serverId: string, map: string, useAmx?: boolean): Promise<CsSendResult> {
  return sendResult(api.post(`/servers/${encodeURIComponent(serverId)}/map`, { map, useAmx }));
}

export async function restartRounds(serverId: string, seconds = 1): Promise<CsSendResult> {
  return sendResult(api.post(`/servers/${encodeURIComponent(serverId)}/restart`, { seconds }));
}

export async function setCvar(serverId: string, cvar: string, value: string): Promise<CsSendResult> {
  return sendResult(api.post(`/servers/${encodeURIComponent(serverId)}/cvar`, { cvar, value }));
}

export async function amxAction(serverId: string, action: string, target: string, extra = ''): Promise<CsSendResult> {
  return sendResult(api.post(`/servers/${encodeURIComponent(serverId)}/amx`, { action, target, extra }));
}

export async function fetchActions(serverId: string, filters: CsActionFilters = {}): Promise<CsAuditPage> {
  const params = new URLSearchParams();
  if (filters.user) params.set('user', filters.user);
  if (filters.action) params.set('action', filters.action);
  if (filters.search) params.set('search', filters.search);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  params.set('page', String(filters.page ?? 1));
  params.set('pageSize', String(filters.pageSize ?? 20));
  const res: any = await unwrap<any>(api.get(`/servers/${encodeURIComponent(serverId)}/actions?${params.toString()}`));
  // Legacy shape (plain array) is still accepted.
  if (Array.isArray(res)) return { actions: res, total: res.length, page: 1, pageSize: res.length, users: [] };
  return {
    actions: res.actions ?? [],
    total: res.total ?? 0,
    page: res.page ?? 1,
    pageSize: res.pageSize ?? 20,
    users: res.users ?? [],
  };
}

export function auditCsvUrl(serverId: string, filters: CsActionFilters = {}): string {
  const params = new URLSearchParams();
  if (filters.user) params.set('user', filters.user);
  if (filters.action) params.set('action', filters.action);
  if (filters.search) params.set('search', filters.search);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  return `/api/plugins/cs16-admin/servers/${encodeURIComponent(serverId)}/actions.csv?${params.toString()}`;
}

export async function fetchBanFiles(serverId: string): Promise<{ available: boolean; files: Record<string, string> }> {
  const res: any = await unwrap<any>(api.get(`/servers/${encodeURIComponent(serverId)}/ban-files`));
  return { available: Boolean(res.available), files: res.files ?? {} };
}

// ── Host console (reads only; writes go through the plugin backend) ─────────

export interface HostLogLine {
  stream: string;
  data: string;
  timestamp?: string;
}

export async function fetchConsoleHistory(serverId: string, lines = 500): Promise<HostLogLine[]> {
  const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/logs?lines=${lines}`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`console history failed (HTTP ${res.status})`);
  const body = await res.json();
  const logs = body?.data?.logs ?? body?.logs ?? [];
  return Array.isArray(logs) ? logs : [];
}

/** Subscribe to live console output via the host SSE stream. */
export function subscribeConsole(
  serverId: string,
  onData: (data: string, stream: string) => void,
  onStatus?: (connected: boolean) => void,
): () => void {
  let closed = false;
  let es: EventSource | null = null;
  try {
    es = new EventSource(`/api/servers/${encodeURIComponent(serverId)}/console/stream`, {
      withCredentials: true,
    });
  } catch {
    onStatus?.(false);
    return () => {};
  }
  onStatus?.(false);
  const handle = (e: MessageEvent) => {
    if (closed) return;
    try {
      const parsed = JSON.parse(e.data);
      const data = typeof parsed?.data === 'string' ? parsed.data : String(e.data ?? '');
      onData(data, typeof parsed?.stream === 'string' ? parsed.stream : 'stdout');
    } catch {
      onData(String((e as MessageEvent).data ?? ''), 'stdout');
    }
  };
  es.addEventListener('console_output', handle as EventListener);
  es.onopen = () => onStatus?.(true);
  es.onerror = () => onStatus?.(false);
  return () => {
    closed = true;
    try {
      es?.removeEventListener('console_output', handle as EventListener);
      es?.close();
    } catch {
      /* ignore */
    }
    es = null;
  };
}
