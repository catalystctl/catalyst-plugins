/**
 * Role-sync engine: mirrors Discord guild roles onto panel roles through the
 * host auth bridge (ctx.auth), which live-checks the `roles.assign` grant and
 * audits every change.
 *
 * Modes:
 *  - 'replaceManaged' (default): the panel roles produced by the mappings
 *    exactly match the user's current Discord roles; panel roles NOT covered
 *    by any mapping are never touched.
 *  - 'addOnly': mappings only ever add panel roles; losing a Discord role
 *    never removes the panel role.
 */

/**
 * Compute + apply the role delta for one user.
 * @returns {{ assigned: string[], removed: string[], skipped?: string }}
 */
export async function syncUserRoles(ctx, { userId, discordRoleIds, settings, trigger }) {
  if (!ctx.auth) throw new Error('Host auth bridge unavailable (panel update required)');
  if (!Array.isArray(discordRoleIds)) discordRoleIds = [];

  const mappings = Array.isArray(settings.roleMappings) ? settings.roleMappings : [];
  const managedPanelRoleIds = [...new Set(mappings.map((m) => m.panelRoleId))];
  const targetPanelRoleIds = [
    ...new Set(
      mappings
        .filter((m) => discordRoleIds.includes(m.discordRoleId))
        .map((m) => m.panelRoleId),
    ),
  ];

  const current = await ctx.auth.listUserRoles(userId);
  const currentIds = current.map((r) => r.id);

  const toAssign = targetPanelRoleIds.filter((id) => !currentIds.includes(id));
  let toRemove = [];
  if ((settings.syncMode || 'replaceManaged') === 'replaceManaged') {
    toRemove = currentIds.filter((id) => managedPanelRoleIds.includes(id) && !targetPanelRoleIds.includes(id));
  }

  if (toAssign.length > 0) {
    await ctx.auth.assignRoles(userId, toAssign, { reason: `discord role sync (${trigger})` });
  }
  if (toRemove.length > 0) {
    await ctx.auth.removeRoles(userId, toRemove, { reason: `discord role sync (${trigger})` });
  }

  if (toAssign.length > 0 || toRemove.length > 0) {
    ctx.emit('discord:roles_synced', {
      userId,
      assigned: toAssign.length,
      removed: toRemove.length,
      trigger,
    });
  }

  return { assigned: toAssign, removed: toRemove };
}

import { fetchGuildMember } from './discord.js';

/**
 * Full sync across every linked account (scheduled task + admin "sync now").
 * Looks up each member with the bot token (Server Members intent required).
 */
export async function syncAllLinks(ctx, { links, settings, maxUsers = 500, log }) {
  const summary = { processed: 0, assigned: 0, removed: 0, errors: 0, notInGuild: 0 };
  if (!settings.botToken || !settings.guildId) {
    summary.skipped = 'bot token and guild id are required for scheduled sync';
    return summary;
  }

  const linksCol = ctx.collection('links');

  for (const link of links.slice(0, maxUsers)) {
    try {
      let member;
      try {
        member = await fetchGuildMember(settings.botToken, settings.guildId, link.discordId);
      } catch (err) {
        if (err?.status === 404) {
          summary.notInGuild += 1;
          if (settings.removeLinkOnLeave) {
            await linksCol.delete({ discordId: link.discordId });
            log?.info({ userId: link.userId }, 'discord-oauth: link removed (user left guild)');
          } else {
            await linksCol.update({ discordId: link.discordId }, { $set: { lastError: 'not in guild', lastSyncedAt: new Date().toISOString() } });
          }
          continue;
        }
        throw err;
      }
      const result = await syncUserRoles(ctx, {
        userId: link.userId,
        discordRoleIds: member?.roles ?? [],
        settings,
        trigger: 'scheduled',
      });
      summary.processed += 1;
      summary.assigned += result.assigned.length;
      summary.removed += result.removed.length;
      await linksCol.update(
        { discordId: link.discordId },
        {
          $set: {
            roles: member?.roles ?? [],
            nick: member?.nick ?? null,
            lastError: null,
            lastSyncedAt: new Date().toISOString(),
          },
        },
      );
      // Be polite to Discord's per-bot rate limits on large link sets.
      await new Promise((r) => setTimeout(r, 400));
    } catch (err) {
      summary.errors += 1;
      log?.warn({ userId: link.userId, error: err.message }, 'discord-oauth sync failed for user');
      try {
        await linksCol.update({ discordId: link.discordId }, { $set: { lastError: String(err.message || err) } });
      } catch {
        /* ignore secondary failure */
      }
    }
  }

  return summary;
}
