/**
 * Licensed Example — admin tab body.
 *
 * Thin shell UI: license status on top, premium report below. The license key
 * itself is a `password` config value (config.licenseKey) and is set from the
 * panel's plugin config UI — this tab never sees or stores it.
 */

import { useCallback, useState } from 'react';
import { createPluginApi } from '@catalyst/plugin-sdk/frontend';
import { KeyRound, Loader2, RefreshCw, Server } from 'lucide-react';

const api = createPluginApi('licensed-example');

interface PremiumReport {
  success: boolean;
  license?: string;
  error?: string;
  entitlements?: string[];
  report?: {
    generatedAt: string;
    serverCount: number;
    servers: Array<{ id: string; name: string; status: string }>;
  };
}

export function LicensedExampleTab() {
  const [report, setReport] = useState<PremiumReport | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await api.get<PremiumReport>('premium-report');
    setReport(res as PremiumReport);
    setLoading(false);
  }, []);

  const active = report?.success === true;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 space-y-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <KeyRound className="h-4 w-4 text-amber-400" />
          License status
          <span className={active ? 'text-emerald-400' : 'text-zinc-400'}>
            {active ? `active (${report?.license ?? 'licensed'})` : report ? 'unavailable' : 'unknown'}
          </span>
        </div>
        <div className="text-xs text-zinc-500">
          The license key (config.licenseKey) is set from the panel's plugin config UI. This tab
          never sees it — activation and payload decryption happen in the encrypted backend.
        </div>
        {report && !active ? (
          <div className="text-xs text-amber-400">{report.error ?? 'request failed'}</div>
        ) : null}
        {active ? (
          <div className="flex flex-wrap gap-1">
            {(report?.entitlements ?? []).map((e) => (
              <span key={e} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300">
                {e}
              </span>
            ))}
          </div>
        ) : null}
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Load premium report
        </button>
      </div>

      {active && report?.report ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Server className="h-4 w-4 text-emerald-400" />
            Premium report
            <span className="text-xs font-normal text-zinc-500">
              {report.report.serverCount} server(s) · generated {new Date(report.report.generatedAt).toLocaleString()}
            </span>
          </div>
          <ul className="divide-y divide-zinc-800 text-xs">
            {report.report.servers.map((s) => (
              <li key={s.id} className="flex items-center justify-between py-1">
                <span className="truncate">{s.name}</span>
                <span className="text-zinc-500">{s.status}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
