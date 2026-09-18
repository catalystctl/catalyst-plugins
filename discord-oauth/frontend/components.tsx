/**
 * Discord OAuth plugin — frontend components.
 *
 * AdminTab: full configuration surface (app credentials, guild, sign-in
 * rules, role mappings, sync settings, linked accounts).
 * DiscordProfileCard: user-facing link/unlink card injected into the
 * profile page via the `profile-connections` slot.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  DiscordIcon,
  FONT_MONO,
  Input,
  Label,
  Loader2,
  Plus,
  RefreshCw,
  Select,
  SelectItem,
  StatusLine,
  TEXT_MUTED,
  Toggle,
  Trash2,
  cn,
} from './ui';
import * as api from './api';
import type { DiscordLink, DiscordRole, PanelRole, PluginSettings, TestResult } from './api';

// ── shared bits ────────────────────────────────────────────────────────────

function timeAgo(iso: string | null | undefined) {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function roleColor(color: number) {
  return color ? `#${color.toString(16).padStart(6, '0')}` : undefined;
}

// ── admin tab ──────────────────────────────────────────────────────────────

function ConnectionCard({
  settings,
  redirectUri,
  onSaved,
}: {
  settings: PluginSettings;
  redirectUri: string;
  onSaved: () => void;
}) {
  const [clientId, setClientId] = useState(settings.clientId);
  const [clientSecret, setClientSecret] = useState('');
  const [botToken, setBotToken] = useState('');
  const [clearClientSecret, setClearClientSecret] = useState(false);
  const [clearBotToken, setClearBotToken] = useState(false);
  const [guildId, setGuildId] = useState(settings.guildId);
  const [frontendUrl, setFrontendUrl] = useState(settings.frontendUrl);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setClientId(settings.clientId);
    setGuildId(settings.guildId);
    setFrontendUrl(settings.frontendUrl);
    setClientSecret('');
    setBotToken('');
    setClearClientSecret(false);
    setClearBotToken(false);
  }, [settings]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.saveConfig({
        clientId,
        guildId,
        frontendUrl,
        ...(clientSecret ? { clientSecret } : clearClientSecret ? { clientSecret: null } : {}),
        ...(botToken ? { botToken } : clearBotToken ? { botToken: null } : {}),
      });
      onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    try {
      setTest(await api.testConnection());
    } catch (err: any) {
      setTest({ success: true, oauthConfigured: false, bot: { ok: false, error: err.message }, guild: { ok: false, error: '' } });
    } finally {
      setTesting(false);
    }
  };

  const botInvite = settings.clientId
    ? `https://discord.com/oauth2/authorize?client_id=${settings.clientId}&scope=bot&permissions=0`
    : null;

  return (
    <Card
      title="Discord application"
      description="OAuth2 client for sign-in, plus an optional bot token for scheduled role sync."
      actions={
        <>
          <Button variant="outline" size="sm" onClick={runTest} disabled={testing}>
            {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            Test connection
          </Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="do-client-id">Client ID</Label>
          <Input id="do-client-id" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="1234567890123456789" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="do-guild-id">Guild ID</Label>
          <Input
            id="do-guild-id"
            value={guildId}
            onChange={(e) => setGuildId(e.target.value.replace(/\D/g, ''))}
            placeholder="Server ID from Discord (Developer Mode → Copy ID)"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="do-frontend-url">
            Public URL <Badge>tunnel / proxy setups</Badge>
          </Label>
          <Input
            id="do-frontend-url"
            value={frontendUrl}
            onChange={(e) => setFrontendUrl(e.target.value)}
            placeholder="https://panel.example.com — set when a tunnel/proxy hides the public hostname"
          />
          <p className={cn('text-[11px]', TEXT_MUTED)}>
            The origin users visit. Used for the Discord redirect URI and post-login redirects. Leave empty when the
            backend receives the real Host header (direct deployments). Required behind Cloudflare Tunnels or a dev
            proxy, where the backend would otherwise see localhost.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="do-client-secret">
            Client Secret{' '}
            {settings.hasClientSecret ? <Badge tone="success">configured</Badge> : <Badge tone="warn">missing</Badge>}
          </Label>
          <Input
            id="do-client-secret"
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={settings.hasClientSecret ? '•••• (leave blank to keep)' : 'Required for sign-in'}
          />
          {settings.hasClientSecret && !clientSecret ? (
            <Toggle
              checked={clearClientSecret}
              onCheckedChange={setClearClientSecret}
              label="Clear stored secret"
            />
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="do-bot-token">
            Bot Token{' '}
            {settings.hasBotToken ? <Badge tone="success">configured</Badge> : <Badge>optional</Badge>}
          </Label>
          <Input
            id="do-bot-token"
            type="password"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder={settings.hasBotToken ? '•••• (leave blank to keep)' : 'Required for scheduled role sync'}
          />
          {settings.hasBotToken && !botToken ? (
            <Toggle checked={clearBotToken} onCheckedChange={setClearBotToken} label="Clear stored token" />
          ) : null}
        </div>
      </div>

      <div className="space-y-1 rounded-md border border-border bg-muted/30 p-3 text-xs">
        <div className={TEXT_MUTED}>
          Add this redirect URI in the Discord developer portal (OAuth2 → Redirects):
        </div>
        <code className={cn('break-all text-[11px]', FONT_MONO)}>{redirectUri}</code>
        <div className={cn('mt-1', TEXT_MUTED)}>Scopes: identify, email, guilds, guilds.members.read</div>
        {botInvite ? (
          <div className={cn('mt-1', TEXT_MUTED)}>
            Invite the bot to your guild, then enable <strong>Server Members Intent</strong> in Bot settings:{' '}
            <a href={botInvite} target="_blank" rel="noreferrer" className="underline">
              invite link
            </a>
          </div>
        ) : null}
      </div>

      {test ? (
        <div className="space-y-1.5">
          <StatusLine ok={test.oauthConfigured}>
            {test.oauthConfigured ? 'OAuth client configured (client id + secret).' : 'OAuth client incomplete — set client ID and secret.'}
          </StatusLine>
          {test.bot.ok ? (
            <StatusLine ok>Bot token valid — signed in as @{test.bot.username}.</StatusLine>
          ) : (
            <StatusLine ok={false}>Bot: {test.bot.error || 'not configured'}</StatusLine>
          )}
          {test.guild.ok ? (
            <StatusLine ok>
              Guild “{test.guild.name}” reachable{test.guild.approximateMemberCount ? ` (~${test.guild.approximateMemberCount} members)` : ''}.
            </StatusLine>
          ) : (
            <StatusLine ok={false}>Guild: {test.guild.error || 'not configured'}</StatusLine>
          )}
        </div>
      ) : null}

      {error ? <StatusLine ok={false}>{error}</StatusLine> : null}
    </Card>
  );
}

function SignInRulesCard({
  settings,
  discordRoles,
  panelRoles,
  onSaved,
}: {
  settings: PluginSettings;
  discordRoles: DiscordRole[];
  panelRoles: PanelRole[];
  onSaved: () => void;
}) {
  const [form, setForm] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setForm(settings), [settings]);

  const set = <K extends keyof PluginSettings>(key: K, value: PluginSettings[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.saveConfig({
        requireGuildMembership: form.requireGuildMembership,
        requiredDiscordRoleIds: form.requiredDiscordRoleIds,
        autoRegister: form.autoRegister,
        linkExistingByEmail: form.linkExistingByEmail,
        markEmailVerified: form.markEmailVerified,
        defaultRoleIds: form.defaultRoleIds,
        loginDisabled: form.loginDisabled,
        removeLinkOnLeave: form.removeLinkOnLeave,
      });
      onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleIn = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  return (
    <Card
      title="Sign-in rules"
      description="Who may sign in with Discord, and what happens on first sign-in."
      actions={
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          Save
        </Button>
      }
    >
      <div className="space-y-3">
        <Toggle
          checked={!form.loginDisabled}
          onCheckedChange={(v) => set('loginDisabled', !v)}
          label="Discord sign-in enabled"
          description="Temporarily hides the “Continue with Discord” button."
        />
        <Toggle
          checked={form.requireGuildMembership}
          onCheckedChange={(v) => set('requireGuildMembership', v)}
          label="Require guild membership"
          description={settings.guildId ? 'Users must be a member of the configured guild to sign in.' : 'Set a guild ID first.'}
        />
        <Toggle
          checked={form.autoRegister}
          onCheckedChange={(v) => set('autoRegister', v)}
          label="Create accounts on first sign-in"
          description="New panel accounts are created for unknown Discord users."
        />
        <Toggle
          checked={form.linkExistingByEmail}
          onCheckedChange={(v) => set('linkExistingByEmail', v)}
          label="Link existing accounts by matching email"
          description="A Discord identity with a verified email matching a panel account links to it (standard OIDC trust model)."
        />
        <Toggle
          checked={form.markEmailVerified}
          onCheckedChange={(v) => set('markEmailVerified', v)}
          label="Trust Discord email verification"
          description="Mark created accounts as email-verified (Discord verifies emails)."
        />
        <Toggle
          checked={form.removeLinkOnLeave}
          onCheckedChange={(v) => set('removeLinkOnLeave', v)}
          label="Unlink accounts that leave the guild"
          description="During scheduled syncs, links for users no longer in the guild are removed."
        />
      </div>

      {discordRoles.length > 0 ? (
        <div className="space-y-1.5">
          <Label>Required Discord roles (any of — empty = no requirement)</Label>
          <div className="flex flex-wrap gap-1.5">
            {discordRoles.map((role) => {
              const active = form.requiredDiscordRoleIds.includes(role.id);
              return (
                <button
                  key={role.id}
                  type="button"
                  onClick={() => set('requiredDiscordRoleIds', toggleIn(form.requiredDiscordRoleIds, role.id))}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-xs transition-colors',
                    active ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent',
                  )}
                  style={active && roleColor(role.color) ? { color: roleColor(role.color), borderColor: roleColor(role.color) } : undefined}
                >
                  {role.name}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {panelRoles.length > 0 ? (
        <div className="space-y-1.5">
          <Label>Default panel roles for created accounts</Label>
          <div className="flex flex-wrap gap-1.5">
            {panelRoles.map((role) => {
              const active = form.defaultRoleIds.includes(role.id);
              return (
                <button
                  key={role.id}
                  type="button"
                  onClick={() => set('defaultRoleIds', toggleIn(form.defaultRoleIds, role.id))}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-xs transition-colors',
                    active ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent',
                  )}
                >
                  {role.name}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {error ? <StatusLine ok={false}>{error}</StatusLine> : null}
    </Card>
  );
}

function MappingsCard({
  settings,
  discordRoles,
  panelRoles,
  onSaved,
}: {
  settings: PluginSettings;
  discordRoles: DiscordRole[];
  panelRoles: PanelRole[];
  onSaved: () => void;
}) {
  const [mappings, setMappings] = useState(settings.roleMappings || []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setMappings(settings.roleMappings || []), [settings]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.saveConfig({ roleMappings: mappings });
      onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const discordName = (id: string) => discordRoles.find((r) => r.id === id)?.name || id;
  const panelName = (id: string) => panelRoles.find((r) => r.id === id)?.name || id;

  return (
    <Card
      title="Role mappings"
      description={
        settings.syncMode === 'addOnly'
          ? 'Discord roles → panel roles. Mappings only ever add panel roles.'
          : 'Discord roles → panel roles. Mapped panel roles exactly mirror Discord membership; unmapped panel roles are never touched.'
      }
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMappings((m) => [...m, { discordRoleId: '', panelRoleId: '' }])}
          >
            <Plus className="h-3 w-3" />
            Add
          </Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            Save
          </Button>
        </>
      }
    >
      {mappings.length === 0 ? (
        <div className={cn('text-xs', TEXT_MUTED)}>
          No mappings yet — add one to mirror a Discord role onto a panel role. Roles apply on Discord sign-in and during
          scheduled syncs (bot token required for the latter).
        </div>
      ) : (
        <div className="space-y-2">
          {mappings.map((mapping, i) => (
            <div key={i} className="flex items-center gap-2">
              <Select
                value={mapping.discordRoleId}
                placeholder="Discord role…"
                onValueChange={(v) => setMappings((m) => m.map((x, j) => (j === i ? { ...x, discordRoleId: v } : x)))}
              >
                {discordRoles.map((role) => (
                  <SelectItem key={role.id} value={role.id}>
                    {role.name}
                  </SelectItem>
                ))}
              </Select>
              <span className={cn('shrink-0 text-xs', TEXT_MUTED)}>→</span>
              <Select
                value={mapping.panelRoleId}
                placeholder="Panel role…"
                onValueChange={(v) => setMappings((m) => m.map((x, j) => (j === i ? { ...x, panelRoleId: v } : x)))}
              >
                {panelRoles.map((role) => (
                  <SelectItem key={role.id} value={role.id}>
                    {role.name}
                  </SelectItem>
                ))}
              </Select>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={() => setMappings((m) => m.filter((_, j) => j !== i))}
                aria-label="Remove mapping"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          {discordRoles.length === 0 ? (
            <div className={cn('text-xs', TEXT_MUTED)}>Configure the bot token + guild ID and test the connection to load Discord roles.</div>
          ) : null}
        </div>
      )}
      {error ? <StatusLine ok={false}>{error}</StatusLine> : null}
    </Card>
  );
}

function SyncCard({ settings, onSaved }: { settings: PluginSettings; onSaved: () => void }) {
  const [syncEnabled, setSyncEnabled] = useState(settings.syncEnabled);
  const [syncSchedule, setSyncSchedule] = useState(settings.syncSchedule);
  const [syncMode, setSyncMode] = useState(settings.syncMode);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSyncEnabled(settings.syncEnabled);
    setSyncSchedule(settings.syncSchedule);
    setSyncMode(settings.syncMode);
  }, [settings]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.saveConfig({ syncEnabled, syncSchedule, syncMode });
      onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const syncNow = async () => {
    setRunning(true);
    setMessage(null);
    setError(null);
    try {
      const summary = await api.runSync();
      setMessage(
        summary.skipped
          ? `Skipped: ${summary.skipped}`
          : `Synced ${summary.processed} links — assigned ${summary.assigned}, removed ${summary.removed}` +
            (summary.errors ? `, ${summary.errors} errors` : '') +
            (summary.notInGuild ? `, ${summary.notInGuild} not in guild` : ''),
      );
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card
      title="Role sync"
      description="Scheduled sync looks up every linked member with the bot token and re-applies mappings."
      actions={
        <>
          <Button variant="outline" size="sm" onClick={syncNow} disabled={running}>
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Sync now
          </Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Toggle
          checked={syncEnabled}
          onCheckedChange={setSyncEnabled}
          label="Scheduled sync enabled"
          description="Runs on the cron schedule below (bot token required)."
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="do-sync-schedule">Schedule (cron, panel timezone)</Label>
            <Input id="do-sync-schedule" value={syncSchedule} onChange={(e) => setSyncSchedule(e.target.value)} placeholder="0 * * * *" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="do-sync-mode">Sync mode</Label>
            <Select value={syncMode} onValueChange={(v) => setSyncMode(v as PluginSettings['syncMode'])}>
              <SelectItem value="replaceManaged">Mirror — remove panel roles when Discord role is lost</SelectItem>
              <SelectItem value="addOnly">Additive — never remove panel roles</SelectItem>
            </Select>
          </div>
        </div>
      </div>
      {message ? <StatusLine ok={!error}>{message}</StatusLine> : null}
      {error ? <StatusLine ok={false}>{error}</StatusLine> : null}
    </Card>
  );
}

function LinksCard() {
  const [data, setData] = useState<{ links: DiscordLink[]; total: number } | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.fetchLinks(page, search));
    } catch {
      setData({ links: [], total: 0 });
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / 25)) : 1;

  return (
    <Card
      title={`Linked accounts${data ? ` (${data.total})` : ''}`}
      description="Panel accounts linked to a Discord identity."
    >
      <div className="flex gap-2">
        <Input placeholder="Search username, email or Discord ID…" value={search} onChange={(e) => { setPage(1); setSearch(e.target.value); }} className="max-w-xs" />
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </Button>
      </div>

      {!loading && data?.links.length === 0 ? (
        <div className={cn('text-xs', TEXT_MUTED)}>No linked accounts yet.</div>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border">
          {(data?.links ?? []).map((link) => (
            <div key={link.userId} className="flex items-center gap-3 px-3 py-2.5">
              {link.avatar ? (
                <img src={link.avatar} alt="" className="h-7 w-7 shrink-0 rounded-full" />
              ) : (
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
                  <DiscordIcon className="h-3.5 w-3.5" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="font-medium">{link.globalName || link.username || link.discordId}</span>
                  {link.panelUsername ? <span className={TEXT_MUTED}>→ {link.panelUsername}</span> : null}
                  {link.panelBanned ? <Badge tone="danger">banned</Badge> : null}
                  {link.lastError ? <Badge tone="warn">{link.lastError}</Badge> : null}
                </div>
                <div className={cn('text-[11px]', TEXT_MUTED)}>
                  linked {timeAgo(link.linkedAt)} · synced {timeAgo(link.lastSyncedAt)} · {link.roles?.length ?? 0} discord roles
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy === link.userId}
                onClick={async () => {
                  setBusy(link.userId);
                  try {
                    await api.unlinkUser(link.userId);
                    await load();
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {totalPages > 1 ? (
        <div className="flex items-center justify-between text-xs">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span className={TEXT_MUTED}>
            Page {page} / {totalPages}
          </span>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

export function DiscordAdminTab() {
  const [config, setConfig] = useState<api.ConfigResponse | null>(null);
  const [guild, setGuild] = useState<{ name: string; roles: DiscordRole[] } | null>(null);
  const [panelRoles, setPanelRoles] = useState<PanelRole[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [cfg, roles] = await Promise.all([api.fetchConfig(), api.fetchPanelRoles().catch(() => [] as PanelRole[])]);
      setConfig(cfg);
      setPanelRoles(roles);
      if (cfg.config.botToken && cfg.config.guildId && cfg.config.hasBotToken) {
        try {
          const g = await api.fetchGuild();
          setGuild({ name: g.guild.name, roles: g.roles });
        } catch {
          setGuild(null);
        }
      } else {
        setGuild(null);
      }
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const settings = config?.config;
  const guildBadge = useMemo(() => {
    if (!settings) return null;
    if (!settings.guildId) return <Badge tone="warn">no guild</Badge>;
    return guild ? <Badge tone="success">{guild.name}</Badge> : <Badge>guild not verified</Badge>;
  }, [settings, guild]);

  if (error) {
    return (
      <div className="space-y-4">
        <Card title="Discord OAuth" description="Failed to load plugin configuration.">
          <StatusLine ok={false}>{error}</StatusLine>
        </Card>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="space-y-4">
        <Card title="Discord OAuth">
          <div className={cn('animate-pulse text-sm', TEXT_MUTED)}>Loading…</div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <DiscordIcon className="h-5 w-5" />
        <h2 className="text-lg font-semibold tracking-tight">Discord OAuth</h2>
        {guildBadge}
        {settings.loginDisabled ? <Badge tone="warn">sign-in disabled</Badge> : null}
        <span className={cn('text-xs', TEXT_MUTED)}>
          {settings.roleMappings.length} mapping{settings.roleMappings.length === 1 ? '' : 's'} · sync{' '}
          {settings.syncEnabled ? `every ${settings.syncSchedule}` : 'off'}
        </span>
      </div>

      <ConnectionCard settings={settings} redirectUri={config?.redirectUri || ''} onSaved={() => void loadAll()} />
      <SignInRulesCard settings={settings} discordRoles={guild?.roles ?? []} panelRoles={panelRoles} onSaved={() => void loadAll()} />
      <MappingsCard settings={settings} discordRoles={guild?.roles ?? []} panelRoles={panelRoles} onSaved={() => void loadAll()} />
      <SyncCard settings={settings} onSaved={() => void loadAll()} />
      <LinksCard />
    </div>
  );
}

// ── profile connections card ───────────────────────────────────────────────

export function DiscordProfileCard() {
  const [link, setLink] = useState<DiscordLink | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLink(await api.fetchMyLink());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Feedback from the OAuth redirect (browser lands back on /profile).
  const justLinked = typeof window !== 'undefined' && window.location.search.includes('discord=linked');
  const linkError = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('oauthError');

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <DiscordIcon className="h-4 w-4" />
        <h3 className="text-sm font-semibold tracking-tight">Discord</h3>
        {link ? <Badge tone="success">linked</Badge> : <Badge>not linked</Badge>}
      </div>

      {loading ? (
        <div className={cn('animate-pulse text-sm', TEXT_MUTED)}>Loading…</div>
      ) : link ? (
        <div className="flex items-center gap-3">
          {link.avatar ? <img src={link.avatar} alt="" className="h-9 w-9 rounded-full" /> : null}
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium">{link.globalName || link.username || link.discordId}</div>
            <div className={cn('text-[11px]', TEXT_MUTED)}>
              {link.username ? `@${link.username}` : link.discordId} · linked {timeAgo(link.linkedAt)}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.unlinkSelf();
                await load();
              } catch (err: any) {
                setError(err.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            Unlink
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className={cn('text-xs', TEXT_MUTED)}>
            Link your Discord account to sign in with Discord and receive panel roles from your Discord roles.
          </p>
          <Button variant="discord" size="sm" onClick={() => (window.location.href = api.linkUrl)}>
            <DiscordIcon className="h-3.5 w-3.5" />
            Link Discord
          </Button>
        </div>
      )}

      {justLinked ? <StatusLine ok>Discord account linked.</StatusLine> : null}
      {linkError ? <StatusLine ok={false}>Linking failed ({linkError}).</StatusLine> : null}
      {error ? <StatusLine ok={false}>{error}</StatusLine> : null}
    </div>
  );
}
