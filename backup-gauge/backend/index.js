/**
 * Backup Gauge — backend.
 *
 * Serves the gauge's presentation settings. The reading itself is assembled in
 * the browser from the panel's own API (see frontend/api.ts), so this plugin
 * stores nothing, reads no panel tables, and declares no permissions.
 */

const DEFAULTS = {
  refreshSeconds: 60,
  warnPercent: 80,
  criticalPercent: 90,
};

/** Clamp a numeric config value; fall back when it is missing or not a number. */
const clamp = (value, fallback, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const plugin = {
  async onLoad(ctx) {
    // Registered relative: the host prefixes /api/plugins/backup-gauge/.
    ctx.registerRoute({
      method: 'GET',
      url: '/config',
      handler: async () => ({
        success: true,
        config: {
          refreshSeconds: clamp(ctx.getConfig('refreshSeconds'), DEFAULTS.refreshSeconds, 15, 3600),
          warnPercent: clamp(ctx.getConfig('warnPercent'), DEFAULTS.warnPercent, 1, 100),
          criticalPercent: clamp(ctx.getConfig('criticalPercent'), DEFAULTS.criticalPercent, 1, 100),
        },
      }),
    });
  },
};

export default plugin;
