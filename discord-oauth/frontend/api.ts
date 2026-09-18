/**
 * Discord OAuth plugin — typed API client via the host plugin SDK.
 *
 * Backend routes return `{ success: true, ...fields }`; the SDK passes such
 * bodies through verbatim (only `success:false` / non-JSON bodies get
 * wrapped), so responses are cast to their expected shapes after the
 * `success` flag is checked.
 */

import { createPluginApi } from '@catalyst/plugin-sdk/frontend';

const api = createPluginApi('discord-oauth');

async function unwrap<T>(res: { success: boolean; error?: string }): Promise<T> {
  if (!res.success) throw new Error(res.error || 'Request failed');
  return res as unknown as T;
}

export interface PluginSettings {
  clientId: string;
  clientSecret: string; // masked
  botToken: string; // masked
  guildId: string;
  /** Absolute frontend origin when the UI is served separately from the API ('' = same-origin). */
  frontendUrl: string;
  requireGuildMembership: boolean;
  requiredDiscordRoleIds: string[];
  autoRegister: boolean;
  linkExistingByEmail: boolean;
  markEmailVerified: boolean;
  defaultRoleIds: string[];
  roleMappings: { discordRoleId: string; panelRoleId: string }[];
  syncMode: 'replaceManaged' | 'addOnly';
  syncSchedule: string;
  syncEnabled: boolean;
  loginDisabled: boolean;
  removeLinkOnLeave: boolean;
  hasClientSecret: boolean;
  hasBotToken: boolean;
}

export interface ConfigResponse {
  config: PluginSettings;
  redirectUri: string;
  scopes: string;
}

export interface TestResult {
  success: boolean;
  oauthConfigured: boolean;
  bot: { ok: boolean; username?: string; error?: string };
  guild: { ok: boolean; name?: string; approximateMemberCount?: number; error?: string };
}

export interface DiscordRole {
  id: string;
  name: string;
  color: number;
  position: number;
}

export interface PanelRole {
  id: string;
  name: string;
  description: string | null;
}

export interface DiscordLink {
  _id?: string;
  userId: string;
  discordId: string;
  username: string | null;
  globalName: string | null;
  avatar: string | null;
  email: string | null;
  roles: string[];
  linkedAt: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  panelUsername?: string | null;
  panelBanned?: boolean | null;
}

export interface SyncSummary {
  processed: number;
  assigned: number;
  removed: number;
  errors: number;
  notInGuild: number;
  skipped?: string;
}

export async function fetchConfig(): Promise<ConfigResponse> {
  return unwrap<ConfigResponse>(await api.get('/settings'));
}

/**
 * Save settings. Secret fields are write-only: a string sets them, `null`
 * clears them, omitting (or '') keeps the stored value.
 */
export async function saveConfig(payload: Record<string, unknown>): Promise<void> {
  await unwrap(await api.put('/settings', payload));
}

export async function testConnection(): Promise<TestResult> {
  return unwrap<TestResult>(await api.post('/settings/test', {}));
}

export async function fetchGuild(): Promise<{ guild: { id: string; name: string; approximateMemberCount?: number }; roles: DiscordRole[] }> {
  return unwrap(await api.get('/guild'));
}

export async function fetchPanelRoles(): Promise<PanelRole[]> {
  const res = await unwrap<{ roles?: PanelRole[] }>(await api.get('/panel-roles'));
  return res.roles ?? [];
}

export async function fetchLinks(page = 1, search = ''): Promise<{ links: DiscordLink[]; total: number; page: number; pageSize: number }> {
  return unwrap(await api.get(`/links?page=${page}&search=${encodeURIComponent(search)}`));
}

export async function unlinkUser(userId: string): Promise<void> {
  await unwrap(await api.del(`/links/${userId}`));
}

export async function runSync(): Promise<SyncSummary> {
  const res = await unwrap<{ summary: SyncSummary }>(await api.post('/sync', {}));
  return res.summary;
}

export async function fetchMyLink(): Promise<DiscordLink | null> {
  const res = await unwrap<{ link?: DiscordLink | null }>(await api.get('/me'));
  return res.link ?? null;
}

export async function unlinkSelf(): Promise<void> {
  await unwrap(await api.del('/me'));
}

export const linkUrl = '/api/plugins/discord-oauth/link';
