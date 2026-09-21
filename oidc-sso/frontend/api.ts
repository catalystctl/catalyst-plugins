/**
 * OIDC SSO plugin — typed API client via the host plugin SDK.
 *
 * Backend routes return `{ success: true, ...fields }`; the SDK passes such
 * bodies through verbatim (only `success:false` / non-JSON bodies get
 * wrapped), so responses are cast to their expected shapes after the
 * `success` flag is checked.
 */

import { createPluginApi } from '@catalyst/plugin-sdk/frontend';

const api = createPluginApi('oidc-sso');

async function unwrap<T>(res: { success: boolean; error?: string }): Promise<T> {
  if (!res.success) throw new Error(res.error || 'Request failed');
  return res as unknown as T;
}

export interface OidcProvider {
  id: string;
  label: string;
  issuer: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string; // masked in reads
  scopes: string;
  usePkce: boolean;
  enabled: boolean;
  autoRegister: boolean;
  linkExistingByEmail: boolean;
  markEmailVerified: boolean;
  defaultRoleIds: string[];
  emailClaim: string;
  usernameClaim: string;
  nameClaim: string;
  avatarClaim: string;
  hasClientSecret?: boolean;
  issues?: string[];
}

export interface PluginSettings {
  frontendUrl: string;
  loginDisabled: boolean;
  providers: OidcProvider[];
}

export interface ConfigResponse {
  config: PluginSettings;
  redirectUri: string;
}

export interface TestResult {
  success: boolean;
  providerId: string;
  clientConfigured: boolean;
  issues: string[];
  discovery?: {
    ok: boolean;
    issuer?: string;
    authorizationEndpoint?: string;
    tokenEndpoint?: string;
    userinfoEndpoint?: string | null;
    jwksUri?: string | null;
    error?: string;
  };
  jwks?: { ok: boolean; keys?: number; error?: string };
}

export interface PanelRole {
  id: string;
  name: string;
  description: string | null;
}

export interface StatusResponse {
  loginDisabled: boolean;
  providers: { id: string; label: string; enabled: boolean; ready: boolean; issues: string[] }[];
  linkCount: number;
  redirectUri: string;
}

export async function fetchConfig(): Promise<ConfigResponse> {
  return unwrap<ConfigResponse>(await api.get('/settings'));
}

export async function saveConfig(payload: {
  frontendUrl?: string;
  loginDisabled?: boolean;
  providers?: OidcProvider[];
}): Promise<void> {
  await unwrap(await api.put('/settings', payload));
}

export async function testProvider(providerId: string): Promise<TestResult> {
  return unwrap<TestResult>(await api.post('/settings/test', { providerId }));
}

export async function fetchPanelRoles(): Promise<PanelRole[]> {
  const res = await unwrap<{ roles?: PanelRole[] }>(await api.get('/panel-roles'));
  return res.roles ?? [];
}

export async function fetchStatus(): Promise<StatusResponse> {
  return unwrap<StatusResponse>(await api.get('/status'));
}

export async function fetchPublicProviders(): Promise<{ id: string; label: string }[]> {
  const res = await unwrap<{ providers?: { id: string; label: string }[] }>(await api.get('/providers'));
  return res.providers ?? [];
}
