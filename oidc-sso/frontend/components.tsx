/**
 * OIDC SSO plugin — frontend components.
 *
 * AdminTab: full configuration surface for any number of OIDC identity
 * providers (issuer, client credentials, scopes, claim mappings, sign-in
 * rules) plus connection testing and the single shared redirect URI.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  SsoIcon,
  FONT_MONO,
  Input,
  Label,
  Loader2,
  Plus,
  RefreshCw,
  StatusLine,
  TEXT_MUTED,
  Toggle,
  Trash2,
  cn,
} from './ui';
import * as api from './api';
import type { OidcProvider, PanelRole, TestResult } from './api';

// ── helpers ──────────────────────────────────────────────────────────────

function slugify(input: string) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/** Drop server-echo fields (masked secret, flags) before saving. */
function stripEcho(p: OidcProvider): OidcProvider {
  const { hasClientSecret: _h, issues: _i, clientSecret: _s, ...rest } = p as OidcProvider & {
    hasClientSecret?: boolean;
    issues?: string[];
  };
  return rest as OidcProvider;
}

const BLANK_PROVIDER: OidcProvider = {  id: '',
  label: '',
  issuer: '',
  discoveryUrl: '',
  clientId: '',
  clientSecret: '',
  scopes: 'openid profile email',
  usePkce: true,
  enabled: true,
  autoRegister: true,
  linkExistingByEmail: true,
  markEmailVerified: true,
  defaultRoleIds: [],
  emailClaim: 'email',
  usernameClaim: 'preferred_username',
  nameClaim: 'name',
  avatarClaim: 'picture',
};

// ── general settings ─────────────────────────────────────────────────────

function GeneralCard({
  frontendUrl,
  loginDisabled,
  redirectUri,
  linkCount,
  onSaved,
}: {
  frontendUrl: string;
  loginDisabled: boolean;
  redirectUri: string;
  linkCount: number;
  onSaved: () => void;
}) {
  const [url, setUrl] = useState(frontendUrl);
  const [disabled, setDisabled] = useState(loginDisabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUrl(frontendUrl);
    setDisabled(loginDisabled);
  }, [frontendUrl, loginDisabled]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.saveConfig({ frontendUrl: url, loginDisabled: disabled });
      onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title="Single sign-on"
      description="One login button, any identity provider. The redirect URI below is shared by every provider — register it once at each IdP."
      actions={
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          Save
        </Button>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="oidc-frontend-url">
            Public URL <Badge>tunnel / proxy setups</Badge>
          </Label>
          <Input
            id="oidc-frontend-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://panel.example.com — set when a tunnel/proxy hides the public hostname"
          />
          <p className={cn('text-[11px]', TEXT_MUTED)}>
            The origin users visit. Used for the redirect URI and post-login redirects. Leave empty for direct
            deployments where the backend sees the real Host header.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label>Linked SSO identities</Label>
          <div className="text-sm">
            {linkCount} identity{linkCount === 1 ? '' : 'ies'} linked across all providers.
          </div>
          <p className={cn('text-[11px]', TEXT_MUTED)}>Links are created automatically on sign-in.</p>
        </div>
      </div>

      <Toggle
        checked={!disabled}
        onCheckedChange={(v) => setDisabled(!v)}
        label="SSO sign-in enabled"
        description="Temporarily hides the “Continue with SSO” button on the login page."
      />

      <div className="space-y-1 rounded-md border border-border bg-muted/30 p-3 text-xs">
        <div className={TEXT_MUTED}>Register this redirect URI at every identity provider (one URI for all):</div>
        <code className={cn('break-all text-[11px]', FONT_MONO)}>{redirectUri}</code>
      </div>

      {error ? <StatusLine ok={false}>{error}</StatusLine> : null}
    </Card>
  );
}

// ── single provider editor ───────────────────────────────────────────────

function ProviderCard({
  provider,
  panelRoles,
  allProviders,
  onSaved,
}: {
  provider: OidcProvider;
  panelRoles: PanelRole[];
  allProviders: OidcProvider[];
  onSaved: () => void;
}) {
  const [form, setForm] = useState<OidcProvider>(provider);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The secret read back from the server is masked — never send it back.
  // A typed draft sets a new secret, the toggle clears it, otherwise the
  // stored value is kept server-side by omitting the field.
  const [secretDraft, setSecretDraft] = useState('');
  const [clearSecret, setClearSecret] = useState(false);

  useEffect(() => {
    setForm(provider);
    setSecretDraft('');
    setClearSecret(false);
  }, [provider]);

  const set = <K extends keyof OidcProvider>(key: K, value: OidcProvider[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  /** Server-echo fields (masked secret, flags) must never round-trip. */
  const toSaveShape = (p: OidcProvider, secret: string | null | undefined) => {
    const { hasClientSecret: _h, issues: _i, ...rest } = p as OidcProvider & {
      hasClientSecret?: boolean;
      issues?: string[];
    };
    const out = { ...rest } as Record<string, unknown>;
    if (secret === null) out.clientSecret = null;
    else if (secret) out.clientSecret = secret;
    else delete out.clientSecret; // omitted = keep stored value
    return out as unknown as OidcProvider;
  };

  const replaceInList = (next: OidcProvider, secret: string | null | undefined) =>
    allProviders.map((p) => (p.id === provider.id ? toSaveShape(next, secret) : toSaveShape(p, undefined)));

  const save = async (next?: OidcProvider, secret?: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await api.saveConfig({ providers: replaceInList(next ?? form, secret) });
      onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async () => {
    const next = { ...form, enabled: !form.enabled };
    setForm(next);
    await save(next);
  };

  const runTest = async () => {
    setTesting(true);
    try {
      setTest(await api.testProvider(provider.id));
    } catch (err: any) {
      setTest({
        success: true,
        providerId: provider.id,
        clientConfigured: false,
        issues: [err.message],
        discovery: { ok: false, error: err.message },
      });
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Remove the "${form.label || form.id}" provider? Linked identities for it stop working.`))
      return;
    setSaving(true);
    try {
      await api.saveConfig({
        providers: allProviders.filter((p) => p.id !== provider.id).map((p) => toSaveShape(p, undefined)),
      });
      onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const saveWithSecret = async () => {
    const trimmed = secretDraft.trim();
    await save(form, trimmed ? trimmed : clearSecret ? null : undefined);
  };

  const toggleIn = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  const ready = (form.issues ?? []).length === 0;

  return (
    <Card
      title={form.label || form.id || 'Untitled provider'}
      description={form.issuer || form.discoveryUrl || 'No issuer configured yet'}
      actions={
        <>
          <Button variant="outline" size="sm" onClick={runTest} disabled={testing}>
            {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            Test
          </Button>
          <Button variant="outline" size="sm" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Collapse' : 'Configure'}
          </Button>
          <Button variant="outline" size="sm" onClick={toggleEnabled} disabled={saving}>
            {form.enabled ? 'Disable' : 'Enable'}
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {form.enabled ? <Badge tone="success">enabled</Badge> : <Badge>disabled</Badge>}
        {ready ? <Badge tone="success">ready</Badge> : <Badge tone="warn">incomplete</Badge>}
        {(form.issues ?? []).map((issue) => (
          <Badge key={issue} tone="warn">
            {issue}
          </Badge>
        ))}
        <button
          type="button"
          onClick={remove}
          className={cn('ml-auto inline-flex items-center gap-1 text-xs', TEXT_MUTED, 'hover:text-red-500')}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Remove
        </button>
      </div>

      {test ? (
        <div className="space-y-1.5 rounded-md border border-border bg-muted/30 p-3">
          <StatusLine ok={test.clientConfigured}>
            {test.clientConfigured ? 'Client ID + secret are configured.' : 'Client ID or secret missing.'}
          </StatusLine>
          {test.discovery?.ok ? (
            <>
              <StatusLine ok>Discovery OK — issuer “{test.discovery.issuer}”.</StatusLine>
              <div className={cn('break-all text-[11px]', TEXT_MUTED, FONT_MONO)}>
                {test.discovery.authorizationEndpoint}
              </div>
            </>
          ) : (
            <StatusLine ok={false}>Discovery: {test.discovery?.error || 'not configured'}</StatusLine>
          )}
          {test.jwks?.ok ? (
            <StatusLine ok>Signing keys reachable ({test.jwks.keys} keys).</StatusLine>
          ) : (
            <StatusLine ok={false}>Signing keys: {test.jwks?.error || 'unknown'}</StatusLine>
          )}
        </div>
      ) : null}

      {expanded ? (
        <div className="space-y-4 pt-1">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Display label</Label>
              <Input
                value={form.label}
                onChange={(e) => {
                  const label = e.target.value;
                  setForm((f) => ({ ...f, label, id: f.id || slugify(label) }));
                }}
                placeholder="Company Login"
              />
            </div>
            <div className="space-y-1.5">
              <Label>ID (used in URLs)</Label>
              <Input value={form.id} onChange={(e) => set('id', slugify(e.target.value))} placeholder="company" />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Issuer URL</Label>
              <Input
                value={form.issuer}
                onChange={(e) => set('issuer', e.target.value)}
                placeholder="https://auth.example.com/realms/main"
              />
              <p className={cn('text-[11px]', TEXT_MUTED)}>
                Keycloak: your realm URL · Authentik: your provider's issuer · Google: https://accounts.google.com ·
                Microsoft: https://login.microsoftonline.com/&lt;tenant&gt;/v2.0 · Okta:
                https://&lt;domain&gt;/oauth2/default
              </p>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Discovery URL override (optional)</Label>
              <Input
                value={form.discoveryUrl}
                onChange={(e) => set('discoveryUrl', e.target.value)}
                placeholder="Defaults to <issuer>/.well-known/openid-configuration"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Client ID</Label>
              <Input value={form.clientId} onChange={(e) => set('clientId', e.target.value)} placeholder="catalyst-panel" />
            </div>
            <div className="space-y-1.5">
              <Label>
                Client Secret{' '}
                {form.hasClientSecret ? <Badge tone="success">configured</Badge> : <Badge tone="warn">missing</Badge>}
              </Label>
              <Input
                type="password"
                value={secretDraft}
                onChange={(e) => {
                  setSecretDraft(e.target.value);
                  setClearSecret(false);
                }}
                placeholder={form.hasClientSecret ? '•••• (leave blank to keep)' : 'Required for confidential clients'}
              />
              {form.hasClientSecret && !secretDraft ? (
                <Toggle checked={clearSecret} onCheckedChange={setClearSecret} label="Clear stored secret" />
              ) : null}
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Scopes</Label>
              <Input
                value={form.scopes}
                onChange={(e) => set('scopes', e.target.value)}
                placeholder="openid profile email"
              />
            </div>
          </div>

          <div className="space-y-3">
            <Toggle
              checked={form.usePkce}
              onCheckedChange={(v) => set('usePkce', v)}
              label="Use PKCE (S256)"
              description="Recommended. Turn off only for providers that reject the code_challenge parameter."
            />
            <Toggle
              checked={form.autoRegister}
              onCheckedChange={(v) => set('autoRegister', v)}
              label="Create accounts on first sign-in"
              description="New panel accounts are created for unknown SSO identities (never for the very first panel account)."
            />
            <Toggle
              checked={form.linkExistingByEmail}
              onCheckedChange={(v) => set('linkExistingByEmail', v)}
              label="Link existing accounts by matching email"
              description="An SSO identity whose email matches a panel account links to it (standard OIDC trust model)."
            />
            <Toggle
              checked={form.markEmailVerified}
              onCheckedChange={(v) => set('markEmailVerified', v)}
              label="Trust the provider's email verification"
              description="Mark created accounts as email-verified. Disable to rely only on the email_verified claim."
            />
          </div>

          <div className="space-y-1.5">
            <Label>Claim mappings (claim names at the provider)</Label>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`oidc-email-${form.id}`}>Email claim</Label>
                <Input
                  id={`oidc-email-${form.id}`}
                  value={form.emailClaim}
                  onChange={(e) => set('emailClaim', e.target.value)}
                  placeholder="email"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`oidc-username-${form.id}`}>Username claim</Label>
                <Input
                  id={`oidc-username-${form.id}`}
                  value={form.usernameClaim}
                  onChange={(e) => set('usernameClaim', e.target.value)}
                  placeholder="preferred_username"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`oidc-name-${form.id}`}>Display-name claim</Label>
                <Input
                  id={`oidc-name-${form.id}`}
                  value={form.nameClaim}
                  onChange={(e) => set('nameClaim', e.target.value)}
                  placeholder="name"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`oidc-avatar-${form.id}`}>Avatar claim</Label>
                <Input
                  id={`oidc-avatar-${form.id}`}
                  value={form.avatarClaim}
                  onChange={(e) => set('avatarClaim', e.target.value)}
                  placeholder="picture"
                />
              </div>
            </div>
          </div>

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
                        active
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:bg-accent',
                      )}
                    >
                      {role.name}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div className="flex justify-end">
            <Button size="sm" onClick={() => void saveWithSecret()} disabled={saving}>
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              Save provider
            </Button>
          </div>
        </div>
      ) : null}

      {error ? <StatusLine ok={false}>{error}</StatusLine> : null}
    </Card>
  );
}

// ── add provider ─────────────────────────────────────────────────────────

function AddProviderCard({ existing, onSaved }: { existing: OidcProvider[]; onSaved: () => void }) {
  const [label, setLabel] = useState('');
  const [issuer, setIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    const id = slugify(label);
    if (!id) {
      setError('Give the provider a label first (the ID is derived from it).');
      return;
    }
    if (existing.some((p) => p.id === id)) {
      setError(`An "${id}" provider already exists — pick a different label.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.saveConfig({
        providers: [
          ...existing.map(stripEcho),
          { ...BLANK_PROVIDER, id, label: label.trim(), issuer: issuer.trim(), clientId: clientId.trim(), clientSecret: clientSecret.trim() },
        ],
      });
      setLabel('');
      setIssuer('');
      setClientId('');
      setClientSecret('');
      onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Add identity provider" description="Each provider gets its own configuration. Users pick theirs on the SSO page when several are enabled.">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="oidc-new-label">Display label</Label>
          <Input id="oidc-new-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Company Keycloak" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="oidc-new-issuer">Issuer URL</Label>
          <Input id="oidc-new-issuer" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://auth.example.com/realms/main" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="oidc-new-client">Client ID</Label>
          <Input id="oidc-new-client" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="catalyst-panel" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="oidc-new-secret">Client Secret</Label>
          <Input id="oidc-new-secret" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="Confidential client secret" />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className={cn('text-[11px]', TEXT_MUTED)}>
          {label ? (
            <>
              ID will be <code className={FONT_MONO}>{slugify(label) || '…'}</code>
            </>
          ) : (
            'Claim mappings and sign-in rules use provider defaults — tune them after adding.'
          )}
        </span>
        <Button size="sm" onClick={add} disabled={saving}>
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          Add provider
        </Button>
      </div>
      {error ? <StatusLine ok={false}>{error}</StatusLine> : null}
    </Card>
  );
}

// ── admin tab ────────────────────────────────────────────────────────────

export function OidcAdminTab() {
  const [config, setConfig] = useState<api.ConfigResponse | null>(null);
  const [status, setStatus] = useState<api.StatusResponse | null>(null);
  const [panelRoles, setPanelRoles] = useState<PanelRole[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [cfg, st, roles] = await Promise.all([
        api.fetchConfig(),
        api.fetchStatus().catch(() => null),
        api.fetchPanelRoles().catch(() => [] as PanelRole[]),
      ]);
      setConfig(cfg);
      setStatus(st);
      setPanelRoles(roles);
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const settings = config?.config;
  const headerStats = useMemo(() => {
    if (!settings) return null;
    const enabled = settings.providers.filter((p) => p.enabled).length;
    return (
      <span className={cn('text-xs', TEXT_MUTED)}>
        {settings.providers.length} provider{settings.providers.length === 1 ? '' : 's'} · {enabled} enabled
        {settings.loginDisabled ? ' · sign-in disabled' : ''}
      </span>
    );
  }, [settings]);

  if (error) {
    return (
      <div className="space-y-4">
        <Card title="OIDC Single Sign-On" description="Failed to load plugin configuration.">
          <StatusLine ok={false}>{error}</StatusLine>
        </Card>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="space-y-4">
        <Card title="OIDC Single Sign-On">
          <div className={cn('animate-pulse text-sm', TEXT_MUTED)}>Loading…</div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <SsoIcon className="h-5 w-5" />
        <h2 className="text-lg font-semibold tracking-tight">OIDC Single Sign-On</h2>
        {settings.loginDisabled ? <Badge tone="warn">sign-in disabled</Badge> : <Badge tone="success">sign-in enabled</Badge>}
        {headerStats}
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => void loadAll()}>
          <RefreshCw className="h-3 w-3" />
          Refresh
        </Button>
      </div>

      <GeneralCard
        frontendUrl={settings.frontendUrl}
        loginDisabled={settings.loginDisabled}
        redirectUri={config?.redirectUri || ''}
        linkCount={status?.linkCount ?? 0}
        onSaved={() => void loadAll()}
      />

      {settings.providers.map((p) => (
        <ProviderCard key={p.id} provider={p} panelRoles={panelRoles} allProviders={settings.providers} onSaved={() => void loadAll()} />
      ))}

      <AddProviderCard existing={settings.providers} onSaved={() => void loadAll()} />
    </div>
  );
}
