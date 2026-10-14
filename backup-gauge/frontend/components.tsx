/**
 * Backup Gauge — server header stat.
 *
 * Rendered into the panel's `server-header-stats` slot, which sits in the
 * server detail header between DISK and NETWORK. Repeats the built-in
 * HeaderStat markup (panel utility classes) so the row reads as one unit.
 */

import { useEffect, useState } from 'react';
import { DatabaseBackup } from 'lucide-react';
import {
  DEFAULT_CONFIG,
  MAX_COUNTED_BACKUPS,
  fetchBackupUsage,
  fetchGaugeConfig,
  type BackupUsage,
  type GaugeConfig,
} from './api';

/** Retry cadence after a failed read (a 403 does not become a 200 in a minute). */
const FAILED_RETRY_SECONDS = 300;

/** Props the host passes through the slot's `componentProps`. */
export interface BackupGaugeProps {
  serverId?: string;
  serverStatus?: string;
  /** Server backup storage allocation (MB); 0 or absent means unallocated. */
  backupAllocationMb?: number | null;
}

const cn = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(' ');

/** Same ramp as the panel's header stats, so values line up column for column. */
function formatMb(mb: number) {
  if (!Number.isFinite(mb) || mb <= 0) return '0 MB';
  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
  }
  return `${Math.round(mb)} MB`;
}

const severityClass = (percent: number | null, config: GaugeConfig) =>
  percent != null && percent >= config.criticalPercent
    ? 'text-danger'
    : percent != null && percent >= config.warnPercent
      ? 'text-warning'
      : 'text-foreground';

const meterTone = (percent: number | null, config: GaugeConfig) =>
  percent != null && percent >= config.criticalPercent
    ? 'bg-danger'
    : percent != null && percent >= config.warnPercent
      ? 'bg-warning'
      : 'bg-muted-foreground/70';

export function BackupGauge({ serverId, backupAllocationMb }: BackupGaugeProps) {
  const [config, setConfig] = useState<GaugeConfig>(DEFAULT_CONFIG);
  const [usage, setUsage] = useState<BackupUsage | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetchGaugeConfig().then((next) => {
      if (alive) setConfig(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!serverId) return;
    let alive = true;
    let timer = 0;

    const schedule = (seconds: number) => {
      timer = window.setTimeout(() => {
        void load();
      }, seconds * 1000);
    };

    const load = async () => {
      const next = await fetchBackupUsage(serverId);
      if (!alive) return;
      setUsage(next);
      setUnavailable(next === null);
      // A viewer without backup.read gets a 403 on every attempt, so a failed
      // read retries on the slow path instead of once a minute per open tab.
      schedule(next ? config.refreshSeconds : Math.max(config.refreshSeconds, FAILED_RETRY_SECONDS));
    };

    void load();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [serverId, config.refreshSeconds]);

  // No server id yet, or the viewer cannot read this server's backups.
  if (!serverId || unavailable) return null;

  const allocationMb =
    typeof backupAllocationMb === 'number' && backupAllocationMb > 0 ? backupAllocationMb : 0;
  const usedMb = usage?.usedMb ?? null;
  const percent =
    allocationMb > 0 && usedMb != null ? Math.min(100, (usedMb / allocationMb) * 100) : null;
  const value =
    usedMb == null
      ? '—'
      : allocationMb > 0
        ? `${formatMb(usedMb)} / ${formatMb(allocationMb)}`
        : formatMb(usedMb);

  const titleParts = [
    usage ? `${usage.count} backup${usage.count === 1 ? '' : 's'}` : 'Loading backups',
    allocationMb > 0
      ? `${formatMb(usedMb ?? 0)} of ${formatMb(allocationMb)} used`
      : 'No backup allocation',
  ];
  if (percent != null) titleParts.push(`${percent.toFixed(0)}%`);
  if (usage?.truncated) titleParts.push(`first ${MAX_COUNTED_BACKUPS} backups counted`);

  return (
    <div className="min-w-[7rem]" title={titleParts.join(' · ')}>
      <div className="flex items-center gap-1 text-muted-foreground">
        <DatabaseBackup className="h-3 w-3" />
        <span className="type-overline">Backup</span>
      </div>
      <div
        className={cn('type-numeric mt-1 whitespace-nowrap text-data', severityClass(percent, config))}
      >
        {value}
      </div>
      <span
        className="mt-1 inline-block h-1 w-full shrink-0 overflow-hidden rounded-[2px] bg-surface-3"
        aria-hidden
      >
        <span
          className={cn(
            'block h-full rounded-[2px] transition-[width] duration-300',
            meterTone(percent, config),
          )}
          style={{ width: `${percent ?? 0}%` }}
        />
      </span>
    </div>
  );
}
