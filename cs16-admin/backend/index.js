/**
 * CS 1.6 Server Admin — backend entry.
 * Validated console commands (allowlist) forwarded as console_input through
 * the host WebSocket gateway, plus persistent bans, settings and action log.
 */

import {
  ALLOWED_CVARS,
  buildAmxAction,
  buildBan,
  buildCvar,
  buildKick,
  buildMap,
  buildRestart,
  buildSay,
  buildStatus,
  buildUnban,
  normalizeMinutes,
  validateCommand,
} from './commands.js';

const DEFAULT_BAN_MINUTES = 1440;
const MAX_ACTIONS_RETURNED = 100;
const MAX_BANS_RETURNED = 200;

function getUserId(ctx, request) {
  try {
    return ctx.getUserId?.(request) ?? request?.user?.userId ?? request?.user?.id ?? null;
  } catch {
    return null;
  }
}

async function loadServer(ctx, serverId) {
  const server = await ctx.db.servers.findUnique({
    where: { id: serverId },
    select: {
      id: true, name: true, uuid: true, status: true, nodeId: true,
      primaryPort: true, primaryIp: true, suspendedAt: true, environment: true,
    },
  });
  if (!server) {
    const err = new Error('server not found');
    err.statusCode = 404;
    throw err;
  }
  if (server.suspendedAt) {
    const err = new Error('server is suspended');
    err.statusCode = 403;
    throw err;
  }
  return server;
}

async function sendConsole(ctx, server, command) {
  const clean = validateCommand(command);
  const gateway = ctx.wsGateway;
  if (!gateway || typeof gateway.sendToAgent !== 'function') {
    throw new Error('console gateway unavailable (agent offline or host misconfigured)');
  }
  const data = clean.endsWith('\n') ? clean : `${clean}\n`;
  const ok = await gateway.sendToAgent(server.nodeId, {
    type: 'console_input',
    serverId: server.id,
    serverUuid: server.uuid,
    data,
  });
  if (!ok) throw new Error('agent is offline — command was not delivered');
  return clean;
}

async function recordAction(ctx, { serverId, action, command, target = null, detail = null, createdBy = null }) {
  try {
    await ctx.collection('cs16_actions').insert({
      id: `act_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      serverId,
      action,
      command,
      target,
      detail,
      createdBy,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    ctx.logger.warn({ err: err?.message, serverId, action }, 'Failed to record admin action');
  }
}

async function getSettings(ctx, serverId) {
  const doc = await ctx.collection('cs16_settings').findOne({ serverId });
  return {
    serverId,
    useAmx: doc?.useAmx ?? (ctx.getConfig('useAmx') ?? true),
    defaultBanMinutes: doc?.defaultBanMinutes ?? (ctx.getConfig('defaultBanMinutes') ?? DEFAULT_BAN_MINUTES),
  };
}

function sendError(reply, err) {
  const status = err?.statusCode && Number.isInteger(err.statusCode) ? err.statusCode : 400;
  return reply.status(status).send({ success: false, error: err?.message || 'request failed' });
}

const plugin = {
  async onLoad(ctx) {
    ctx.logger.info('CS 1.6 Admin plugin loaded');
    const requireWrite = (...extra) =>
      ctx.requirePermission?.('console.write', 'server.write', 'admin.write', ...extra) ??
      ((req, reply, done) => done?.());
    const requireRead = (...extra) =>
      ctx.requirePermission?.('console.read', 'console.write', 'server.read', 'server.write', 'admin.read', 'admin.write', ...extra) ??
      ((req, reply, done) => done?.());

    // Server info + effective settings + ban/action counts for the tab header.
    ctx.registerRoute({
      method: 'GET',
      url: '/servers/:id/info',
      preHandler: requireRead(),
      handler: async (request, reply) => {
        try {
          const server = await loadServer(ctx, request.params.id);
          const settings = await getSettings(ctx, server.id);
          const [activeBans, actionCount] = await Promise.all([
            ctx.collection('cs16_bans').count({ serverId: server.id, status: 'active' }).catch(() => 0),
            ctx.collection('cs16_actions').count({ serverId: server.id }).catch(() => 0),
          ]);
          return {
            success: true,
            server: {
              id: server.id, name: server.name, uuid: server.uuid, status: server.status,
              nodeId: server.nodeId, primaryIp: server.primaryIp, primaryPort: server.primaryPort,
            },
            settings,
            activeBans,
            actionCount,
          };
        } catch (err) {
          return sendError(reply, err);
        }
      },
    });

    // Per-server settings (AMX mode, default ban length).
    ctx.registerRoute({
      method: 'GET',
      url: '/servers/:id/settings',
      preHandler: requireRead(),
      handler: async (request, reply) => {
        try {
          await loadServer(ctx, request.params.id);
          return { success: true, settings: await getSettings(ctx, request.params.id) };
        } catch (err) {
          return sendError(reply, err);
        }
      },
    });

    ctx.registerRoute({
      method: 'PUT',
      url: '/servers/:id/settings',
      preHandler: requireWrite(),
      handler: async (request, reply) => {
        try {
          const server = await loadServer(ctx, request.params.id);
          const body = request.body ?? {};
          const patch = {};
          if (body.useAmx !== undefined) patch.useAmx = Boolean(body.useAmx);
          if (body.defaultBanMinutes !== undefined) {
            patch.defaultBanMinutes = normalizeMinutes(body.defaultBanMinutes, DEFAULT_BAN_MINUTES);
          }
          if (Object.keys(patch).length === 0) {
            return reply.status(400).send({ success: false, error: 'nothing to update' });
          }
          patch.updatedAt = new Date().toISOString();
          const existing = await ctx.collection('cs16_settings').findOne({ serverId: server.id });
          if (existing) {
            await ctx.collection('cs16_settings').update({ serverId: server.id }, { $set: patch });
          } else {
            await ctx.collection('cs16_settings').insert({ serverId: server.id, ...patch });
          }
          return { success: true, settings: await getSettings(ctx, server.id) };
        } catch (err) {
          return sendError(reply, err);
        }
      },
    });

    // Ask the server for a fresh `status` dump (players are parsed client-side
    // from the live console stream).
    ctx.registerRoute({
      method: 'POST',
      url: '/servers/:id/refresh-players',
      preHandler: requireWrite(),
      handler: async (request, reply) => {
        try {
          const server = await loadServer(ctx, request.params.id);
          const sent = await sendConsole(ctx, server, buildStatus());
          await recordAction(ctx, {
            serverId: server.id, action: 'refresh-players', command: sent,
            createdBy: getUserId(ctx, request),
          });
          return { success: true, sent };
        } catch (err) {
          return sendError(reply, err);
        }
      },
    });

    // Validated raw command box.
    ctx.registerRoute({
      method: 'POST',
      url: '/servers/:id/command',
      preHandler: requireWrite(),
      handler: async (request, reply) => {
        try {
          const server = await loadServer(ctx, request.params.id);
          const sent = await sendConsole(ctx, server, String(request.body?.command || ''));
          await recordAction(ctx, {
            serverId: server.id, action: 'command', command: sent,
            createdBy: getUserId(ctx, request),
          });
          ctx.emitTyped?.('cs16-admin:command-sent', { serverId: server.id, command: sent });
          return { success: true, sent };
        } catch (err) {
          return sendError(reply, err);
        }
      },
    });

    // Admin chat into the game.
    ctx.registerRoute({
      method: 'POST',
      url: '/servers/:id/say',
      preHandler: requireWrite(),
      handler: async (request, reply) => {
        try {
          const server = await loadServer(ctx, request.params.id);
          const settings = await getSettings(ctx, server.id);
          const body = request.body ?? {};
          const useAmx = body.useAmx ?? settings.useAmx ?? false;
          const sent = await sendConsole(
            ctx, server,
            buildSay(String(body.message || ''), { team: Boolean(body.team), useAmx: Boolean(useAmx) }),
          );
          await recordAction(ctx, {
            serverId: server.id, action: 'say', command: sent,
            detail: body.team ? 'team' : 'all', createdBy: getUserId(ctx, request),
          });
          return { success: true, sent };
        } catch (err) {
          return sendError(reply, err);
        }
      },
    });

    // Kick (userid like #5 or name).
    ctx.registerRoute({
      method: 'POST',
      url: '/servers/:id/kick',
      preHandler: requireWrite(),
      handler: async (request, reply) => {
        try {
          const server = await loadServer(ctx, request.params.id);
          const settings = await getSettings(ctx, server.id);
          const body = request.body ?? {};
          const useAmx = body.useAmx ?? settings.useAmx ?? false;
          const sent = await sendConsole(
            ctx, server,
            buildKick({ userid: body.userid, name: body.name, reason: body.reason, useAmx: Boolean(useAmx) }),
          );
          const target = body.userid || body.name || body.steamId || 'unknown';
          await recordAction(ctx, {
            serverId: server.id, action: 'kick', command: sent, target,
            detail: body.reason || null, createdBy: getUserId(ctx, request),
          });
          ctx.emitTyped?.('cs16-admin:player-kicked', { serverId: server.id, steamId: String(body.steamId || target) });
          return { success: true, sent };
        } catch (err) {
          return sendError(reply, err);
        }
      },
    });

    // Timed ban + persistent record.
    ctx.registerRoute({
      method: 'POST',
      url: '/servers/:id/ban',
      preHandler: requireWrite(),
      handler: async (request, reply) => {
        try {
          const server = await loadServer(ctx, request.params.id);
          const settings = await getSettings(ctx, server.id);
          const body = request.body ?? {};
          const useAmx = body.useAmx ?? settings.useAmx ?? false;
          const minutes = normalizeMinutes(body.minutes ?? settings.defaultBanMinutes, DEFAULT_BAN_MINUTES);
          const sent = await sendConsole(
            ctx, server,
            buildBan({ steamId: body.steamId, name: body.name, minutes, reason: body.reason, useAmx: Boolean(useAmx) }),
          );
          const createdBy = getUserId(ctx, request);
          const ban = {
            id: `ban_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
            serverId: server.id,
            name: String(body.name || '').slice(0, 48) || null,
            steamId: String(body.steamId || '').trim().toUpperCase(),
            minutes,
            reason: String(body.reason || '').slice(0, 128) || null,
            command: sent,
            status: 'active',
            createdBy,
            createdAt: new Date().toISOString(),
          };
          await ctx.collection('cs16_bans').insert(ban);
          await recordAction(ctx, {
            serverId: server.id, action: 'ban', command: sent, target: ban.steamId,
            detail: ban.reason, createdBy,
          });
          if (minutes === 0 && (ctx.getConfig('writeBansFile') ?? false) && ctx.fileTunnel) {
            try {
              const dl = await ctx.fileTunnel.queueRequest(server.nodeId, 'download', server.uuid, 'cstrike/banned.cfg');
              const existing = dl?.success && dl.body ? dl.body.toString('utf8') : '';
              const line = `banid 0 ${ban.steamId}`;
              if (!existing.includes(ban.steamId)) {
                await ctx.fileTunnel.queueRequest(
                  server.nodeId, 'upload', server.uuid, 'cstrike/banned.cfg', {},
                  Buffer.from(`${existing}${existing.endsWith('\n') || !existing ? '' : '\n'}${line}\n`, 'utf8'),
                );
              }
            } catch (err) {
              ctx.logger.warn({ err: err?.message, serverId: server.id }, 'Failed to persist ban to banned.cfg');
            }
          }
          ctx.emitTyped?.('cs16-admin:player-banned', { serverId: server.id, steamId: ban.steamId });
          return { success: true, sent, ban };
        } catch (err) {
          return sendError(reply, err);
        }
      },
    });

    // Unban + mark the stored record.
    ctx.registerRoute({
      method: 'POST',
      url: '/servers/:id/unban',
      preHandler: requireWrite(),
      handler: async (request, reply) => {
        try {
          const server = await loadServer(ctx, request.params.id);
          const settings = await getSettings(ctx, server.id);
          const body = request.body ?? {};
          const useAmx = body.useAmx ?? settings.useAmx ?? false;
          const steamId = String(body.steamId || '').trim().toUpperCase();
          const sent = await sendConsole(ctx, server, buildUnban({ steamId, useAmx: Boolean(useAmx) }));
          await ctx.collection('cs16_bans').update(
            { serverId: server.id, steamId, status: 'active' },
            { $set: { status: 'unbanned', unbannedAt: new Date().toISOString() } },
          );
          await recordAction(ctx, {
            serverId: server.id, action: 'unban', command: sent, target: steamId,
            createdBy: getUserId(ctx, request),
          });
          return { success: true, sent };
        } catch (err) {
          return sendError(reply, err);
        }
      },
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/servers/:id/bans',
      preHandler: requireRead(),
      handler: async (request, reply) => {
        try {
          const server = await loadServer(ctx, request.params.id);
          const bans = await ctx.collection('cs16_bans').find(
            { serverId: server.id }, { sort: { createdAt: -1 }, limit: MAX_BANS_RETURNED },
          );
          return { success: true, bans };
        } catch (err) {
          return sendError(reply, err);
        }
      },
    });

    // Map change.
    ctx.registerRoute({
      method: 'POST',
      url: '/servers/:id/map',
      preHandler: requireWrite(),
      handler: async (request, reply) => {
        try {
          const server = await loadServer(ctx, request.params.id);
          const settings = await getSettings(ctx, server.id);
          const body = request.body ?? {};
          const useAmx = body.useAmx ?? settings.useAmx ?? false;
          const sent = await sendConsole(ctx, server, buildMap(String(body.map || ''), { useAmx: Boolean(useAmx) }));
          await recordAction(ctx, {
            serverId: server.id, action: 'map', command: sent, target: String(body.map || ''),
            createdBy: getUserId(ctx, request),
          });
          ctx.emitTyped?.('cs16-admin:map-changed', { serverId: server.id, map: String(body.map || '') });
          return { success: true, sent };
        } catch (err) {
          return sendError(reply, err);
        }
      },
    });

    // Round restart.
    ctx.registerRoute({
      method: 'POST',
      url: '/servers/:id/restart',
      preHandler: requireWrite(),
      handler: async (request, reply) => {
        try {
          const server = await loadServer(ctx, request.params.id);
          const sent = await sendConsole(ctx, server, buildRestart(request.body?.seconds));
          await recordAction(ctx, {
            serverId: server.id, action: 'restart', command: sent,
            createdBy: getUserId(ctx, request),
          });
          return { success: true, sent };
        } catch (err) {
          return sendError(reply, err);
        }
      },
    });

    // Match cvars.
    ctx.registerRoute({
      method: 'POST',
      url: '/servers/:id/cvar',
      preHandler: requireWrite(),
      handler: async (request, reply) => {
        try {
          const server = await loadServer(ctx, request.params.id);
          const body = request.body ?? {};
          if (!ALLOWED_CVARS.has(String(body.cvar))) {
            return reply.status(400).send({ success: false, error: `cvar not allowed: ${body.cvar}` });
          }
          const sent = await sendConsole(ctx, server, buildCvar(String(body.cvar), body.value));
          await recordAction(ctx, {
            serverId: server.id, action: 'cvar', command: sent, target: String(body.cvar),
            detail: String(body.value ?? ''), createdBy: getUserId(ctx, request),
          });
          return { success: true, sent };
        } catch (err) {
          return sendError(reply, err);
        }
      },
    });

    // AMX slap / slay / gag / mute.
    ctx.registerRoute({
      method: 'POST',
      url: '/servers/:id/amx',
      preHandler: requireWrite(),
      handler: async (request, reply) => {
        try {
          const server = await loadServer(ctx, request.params.id);
          const body = request.body ?? {};
          const sent = await sendConsole(
            ctx, server, buildAmxAction(String(body.action || ''), body.target, body.extra),
          );
          await recordAction(ctx, {
            serverId: server.id, action: `amx_${body.action}`, command: sent,
            target: String(body.target || ''), createdBy: getUserId(ctx, request),
          });
          return { success: true, sent };
        } catch (err) {
          return sendError(reply, err);
        }
      },
    });

    // Recent admin actions for the activity panel.
    ctx.registerRoute({
      method: 'GET',
      url: '/servers/:id/actions',
      preHandler: requireRead(),
      handler: async (request, reply) => {
        try {
          const server = await loadServer(ctx, request.params.id);
          const limit = Math.min(MAX_ACTIONS_RETURNED, Math.max(1, Number(request.query?.limit) || 30));
          const actions = await ctx.collection('cs16_actions').find(
            { serverId: server.id }, { sort: { createdAt: -1 }, limit },
          );
          return { success: true, actions };
        } catch (err) {
          return sendError(reply, err);
        }
      },
    });

    // Best-effort read of ban files through the file tunnel.
    ctx.registerRoute({
      method: 'GET',
      url: '/servers/:id/ban-files',
      preHandler: requireRead(),
      handler: async (request, reply) => {
        try {
          const server = await loadServer(ctx, request.params.id);
          if (!ctx.fileTunnel) return { success: true, available: false, files: {} };
          const paths = ['cstrike/banned.cfg', 'cstrike/listip.cfg', 'cstrike/addons/amxmodx/data/banned.cfg'];
          const files = {};
          for (const p of paths) {
            try {
              const res = await ctx.fileTunnel.queueRequest(server.nodeId, 'download', server.uuid, p);
              files[p] = res?.success && res.body
                ? res.body.toString('utf8').slice(0, 20000)
                : `(${res?.error || 'not found'})`;
            } catch (err) {
              files[p] = `(${err?.message || 'unavailable'})`;
            }
          }
          return { success: true, available: true, files };
        } catch (err) {
          return sendError(reply, err);
        }
      },
    });
  },

  async onEnable(ctx) {
    ctx.logger.info('CS 1.6 Admin plugin enabled');
  },

  async onDisable(ctx) {
    ctx.logger.info('CS 1.6 Admin plugin disabled');
  },

  async onUnload(ctx) {
    ctx.logger.info('CS 1.6 Admin plugin unloaded');
  },
};

export default plugin;
