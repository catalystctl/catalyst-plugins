/**
 * Bootstrap — the entire plaintext surface of the plugin.
 *
 * All it does is locate the encrypted payload, hand it to the SDK's
 * `loadLicensedModule` (activate → unwrap DEK → decrypt → import via a
 * `data:` URL) and forward lifecycle hooks to the decrypted module. The
 * valuable code lives in `payload-src/index.ts`, which ships only as
 * `backend/payload.enc`.
 *
 * `loadLicensedModule` returns `null` when running unentitled (only possible
 * with `failMode: 'open'`); with the default `failMode: 'closed'` on an
 * encrypted plugin it throws and the plugin fails to load — that throw is
 * the enforcement.
 */
import { readFileSync } from 'node:fs';
import { loadLicensedModule } from '@catalyst/plugin-sdk/licensing';

let real: any;

async function boot(ctx: any) {
  if (real) return real;
  const payload = new Uint8Array(readFileSync(new URL('./payload.enc', import.meta.url)));
  real = await loadLicensedModule(ctx, { payload, keyField: 'licenseKey' });
  return real;
}

export default {
  async onLoad(ctx: any) { (await boot(ctx))?.onLoad?.(ctx); },
  async onEnable(ctx: any) { (await boot(ctx))?.onEnable?.(ctx); },
  async onDisable(ctx: any) { real?.onDisable?.(ctx); },
  async onUnload(ctx: any) { real?.onUnload?.(ctx); },
};
