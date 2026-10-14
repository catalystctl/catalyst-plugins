/**
 * Backup Gauge — data access.
 *
 * Config comes from the plugin's own backend. Backup usage comes from the
 * panel's backup list endpoint, called with the signed-in user's session so
 * the reading is subject to that user's `backup.read` grant.
 */

import { createPluginApi } from '@catalyst/plugin-sdk/frontend';

const pluginApi = createPluginApi('backup-gauge');

export interface GaugeConfig {
  /** Seconds between usage refreshes. */
  refreshSeconds: number;
  /** Usage percent at which the reading turns amber. */
  warnPercent: number;
  /** Usage percent at which the reading turns red. */
  criticalPercent: number;
}

export const DEFAULT_CONFIG: GaugeConfig = {
  refreshSeconds: 60,
  warnPercent: 80,
  criticalPercent: 90,
};

export interface BackupUsage {
  /** Sum of the stored backups' sizes, in MB. */
  usedMb: number;
  /** Number of backups counted. */
  count: number;
  /** True when the server holds more backups than one refresh walks. */
  truncated: boolean;
}

/** One page of GET /api/servers/:id/backups. */
interface BackupPage {
  backups?: Array<{ sizeMb?: number | null }>;
  totalPages?: number;
}

const PAGE_SIZE = 100;
/** Backups walked per refresh; servers beyond this report a lower bound. */
const MAX_PAGES = 10;
/** Ceiling on backups counted in one refresh. */
export const MAX_COUNTED_BACKUPS = PAGE_SIZE * MAX_PAGES;

/** Presentation settings; falls back to defaults when the backend is unreachable. */
export async function fetchGaugeConfig(): Promise<GaugeConfig> {
  const res = (await pluginApi.get('/config')) as unknown as {
    success?: boolean;
    config?: Partial<GaugeConfig>;
  };
  if (!res || res.success === false || !res.config) return DEFAULT_CONFIG;
  return { ...DEFAULT_CONFIG, ...res.config };
}

async function fetchPage(serverId: string, page: number): Promise<BackupPage | null> {
  const url = `/api/servers/${encodeURIComponent(serverId)}/backups?limit=${PAGE_SIZE}&page=${page}`;
  try {
    const res = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as BackupPage;
  } catch {
    return null;
  }
}

/**
 * Sum the server's backup sizes.
 *
 * Returns null when the caller may not read backups (403) or the panel is
 * unreachable, so the gauge can hide itself instead of showing a false zero.
 */
export async function fetchBackupUsage(serverId: string): Promise<BackupUsage | null> {
  const first = await fetchPage(serverId, 1);
  if (!first) return null;

  const totalPages = Math.max(1, Number(first.totalPages) || 1);
  const lastPage = Math.min(totalPages, MAX_PAGES);
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, lastPage - 1) }, (_, index) => fetchPage(serverId, index + 2)),
  );

  const pages = [first, ...rest.filter((page): page is BackupPage => page !== null)];
  let usedMb = 0;
  let count = 0;
  for (const page of pages) {
    for (const backup of page.backups ?? []) {
      usedMb += Number(backup.sizeMb) || 0;
      count += 1;
    }
  }

  // A page we could not read (or never walked) makes the sum a lower bound.
  const truncated = totalPages > MAX_PAGES || pages.length < totalPages;
  return { usedMb, count, truncated };
}
