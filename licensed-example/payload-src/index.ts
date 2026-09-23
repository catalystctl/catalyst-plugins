/**
 * The valuable code — this file never ships in the clear.
 *
 * It is bundled to a single self-contained ESM file and sealed into
 * `backend/payload.enc` at build time. At runtime the bootstrap decrypts it
 * and imports it from a `data:` URL, so the plaintext never touches disk.
 *
 * Entitlements: `loadLicensedModule` (in the bootstrap) has already activated
 * the license and cached the activation in plugin storage by the time
 * `onLoad` runs here, so `activateLicense` below is served from that cache —
 * it re-derives the KEK and unwraps the DEK locally, with no second network
 * call, and hands us the entitlement list from the activation.
 */
import { activateLicense } from '@catalyst/plugin-sdk/licensing';

let entitlements: string[] = [];

const plugin = {
  async onLoad(ctx: any) {
    const act = await activateLicense(ctx, { keyField: 'licenseKey' });
    entitlements = act.entitlements;

    ctx.registerRoute({
      method: 'GET',
      url: '/premium-report',
      preHandler: ctx.requirePermission('server.read'),
      handler: async () => {
        const servers = await ctx.db.servers.findMany({
          select: { id: true, name: true, status: true },
          take: 25,
        });
        return {
          success: true,
          license: 'active',
          report: {
            generatedAt: new Date().toISOString(),
            serverCount: servers.length,
            servers,
          },
          entitlements,
        };
      },
    });
  },
};

export default plugin;
