/**
 * CS 1.6 Server Admin — backend entry.
 *
 * Command transport (per server, `transport` setting):
 *   auto  — RCON over UDP when a password is available, otherwise stdin
 *   rcon  — RCON only (errors when unavailable)
 *   stdin — panel console input only (previous behavior)
 *
 * RCON is the reliable GoldSrc path: authenticated per command with a real
 * response (used for `status` output). Stdin stays as a zero-config fallback.
 * Writes require console.write, server.write or admin.write on the caller.
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
import {
  parseRconPassword,
  rconCommand,
} from './rcon.js';
import {
  MAX_AUDIT_PER_SERVER,
  actionsToCsv,
  applyActionFilters,
  distinctActors,
  overRetentionOldestFirst,
  paginateActions,
} from './audit.js';

const DEFAULT_BAN_MINUTES = 1440;
const MAX_ACTIONS_RETURNED = 100;
const MAX_BANS_RETURNED = 200;
const TRANSPORTS = new Set(['auto', 'rcon', 'stdin']);

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

function gameDirOf(server) {
  const env = server?.environment;
  const raw = env && typeof env === 'object' ? env.HLDS_GAME || env.hlDs_game : null;
  const clean = String(raw || 'cstrike').trim();
  return /^[A-Za-z0-9_\-]+$/.test(clean) ? clean : 'cstrike';
}

/**
 * Resolve RCON connectivity for a server.
 * Password precedence: manual settings override, then <game>/server.cfg
 * discovered through the file tunnel. The secret itself is never returned —
 * only where it came from.
 */
async function resolveRcon(ctx, server, settings) {
  const port = Number(settings.rconPort) || Number(server.primaryPort) || 0;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { available: false, reason: 'no game port known for this server' };
  }
  let host = String(settings.rconHost || server.primaryIp || '').trim();
  if (!host || host === '0.0.0.0' || host === '::') {
    return {
      available: false,
      reason: 'no reachable address (set the RCON host to the node public IP)',
    };
  }
  if (settings.rconPassword) {
    return { available: true, host, port, password: settings.rconPassword, source: 'manual' };
  }
  if (ctx.fileTunnel) {
    try {
      const res = await ctx.fileTunnel.queueRequest(
        server.nodeId, 'download', server.uuid, `${gameDirOf(server)}/server.cfg`,
      );
      if (res?.success && res.body) {
        const found = parseRconPassword(res.body.toString('utf8'));
        if (found) {
          return { available: true, host, port, password: found, source: 'server.cfg' };
        }
      }
    } catch (err) {
      ctx.logger.debug({ err: err?.message, serverId: server.id }, 'RCON password auto-detect failed');
    }
  }
  return { available: false, reason: 'no rcon password (set one in server.cfg or the tab settings)' };
}

async function sendStdin(ctx, server, command) {
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

/**
 * Send a validated command via the effective transport.
 * Returns { command, transport, output? } — output is set when RCON ran.
 */
async function sendConsole(ctx, server, command, settings, { wantOutput = false } = {}) {
  const mode = TRANSPORTS.has(settings.transport) ? settings.transport : 'auto';
  if (mode !== 'stdin') {
    const rcon = await resolveRcon(ctx, server, settings);
    if (rcon.available) {
      try {
        const output = await rconCommand({
          host: rcon.host, port: rcon.port, password: rcon.password, command,
        });
        return { command: validateCommand(command), transport: 'rcon', output };
      } catch (err) {
        if (mode === 'rcon') throw err;
        ctx.logger.warn({ err: err?.message, serverId: server.id }, 'RCON failed, falling back to stdin');
      }
    } else if (mode === 'rcon') {
      throw new Error(`rcon unavailable: ${rcon.reason}`);
    }
  }
  const clean = await sendStdin(ctx, server, command);
  return { command: clean, transport: 'stdin', output: null };
}

/** Resolve a user id to a display name (null when user.read is not granted). */
async function actorName(ctx, userId) {
  if (!userId) return null;
  try {
    const user = await ctx.db.users.findUnique({
      where: { id: userId },
      select: { username: true, name: true },
    });
    return user?.username || user?.name || null;
  } catch {
    return null;
  }
}

async function recordAction(ctx, { serverId, action, command, target = null, detail = null, createdBy = null, transport = null }) {
  try {
    let createdByName = null;
    try {
      createdByName = createdBy ? await actorName(ctx, createdBy) : null;
    } catch {
      createdByName = null;
    }
    await ctx.collection('cs16_actions').insert({
      id: `act_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      serverId,
      action,
      command,
      target,
      detail: [detail, transport ? `via ${transport}` : null].filter(Boolean).join(' ') || null,
      createdBy,
      createdByName,
      createdAt: new Date().toISOString(),
    });
    // Bound the log: prune oldest beyond the retention cap.
    try {
      const all = await ctx.collection('cs16_actions').find({ serverId });
      for (const old of overRetentionOldestFirst(all, MAX_AUDIT_PER_SERVER)) {
        if (old?._id) await ctx.collection('cs16_actions').delete({ _id: old._id });
      }
    } catch (err) {
      ctx.logger.debug({ err: err?.message, serverId }, 'Audit retention prune failed');
    }
  } catch (err) {
    ctx.logger.warn({ err: err?.message, serverId, action }, 'Failed to record admin action');
  }
}

/**
 * Attach display names to audit docs missing them (records written before
 * the name was stored, or after a username change). Never throws.
 */
async function backfillActorNames(ctx, docs) {
  const ids = [...new Set(
    (Array.isArray(docs) ? docs : [])
      .filter((d) => d?.createdBy && !d.createdByName)
      .map((d) => d.createdBy),
  )];
  if (ids.length === 0) return docs;
  try {
    const users = await ctx.db.users.findMany({
      where: { id: { in: ids } },
      select: { id: true, username: true, name: true },
    });
    const names = new Map((users || []).map((u) => [u.id, u.username || u.name || u.id]));
    return docs.map((d) => (
      d?.createdBy && !d.createdByName && names.has(d.createdBy)
        ? { ...d, createdByName: names.get(d.createdBy) }
        : d
    ));
  } catch {
    return docs;
  }
}

async function getSettings(ctx, serverId) {
  const doc = await ctx.collection('cs16_settings').findOne({ serverId });
  const fallbackTransport = TRANSPORTS.has(ctx.getConfig('defaultTransport'))
    ? ctx.getConfig('defaultTransport')
    : 'auto';
  return {
    serverId,
    useAmx: doc?.useAmx ?? (ctx.getConfig('useAmx') ?? true),
    defaultBanMinutes: doc?.defaultBanMinutes ?? (ctx.getConfig('defaultBanMinutes') ?? DEFAULT_BAN_MINUTES),
    transport: doc?.transport ?? fallbackTransport,
    rconHost: doc?.rconHost ?? '',
    rconPort: doc?.rconPort ?? 0,
    // Write-only secret: callers learn only whether one is stored.
    rconConfigured: Boolean(doc?.rconPassword),
  };
}

async function getRconSecret(ctx, serverId) {
  const doc = await ctx.collection('cs16_settings').findOne({ serverId });
  return doc?.rconPassword || '';
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

    // Per-server settings (AMX mode, default ban length, transport, RCON).
    // The RCON password is write-only: GET reports rconConfigured, never the secret.
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
          if (body.transport !== undefined) {
            if (!TRANSPORTS.has(body.transport)) {
              return reply.status(400).send({ success: false, error: 'transport must be auto, rcon or stdin' });
            }
            patch.transport = body.transport;
          }
          if (body.rconHost !== undefined) patch.rconHost = String(body.rconHost || '').trim();
          if (body.rconPort !== undefined) {
            const port = Number(body.rconPort) || 0;
            if (body.rconPort !== '' && body.rconPort !== 0 && (!Number.isInteger(port) || port < 1 || port > 65535)) {
              return reply.status(400).send({ success: false, error: 'rcon port must be 1-65535' });
            }
            patch.rconPort = port;
          }
          if (body.rconPassword !== undefined) {
            if (typeof body.rconPassword !== 'string' || body.rconPassword.length > 128) {
              return reply.status(400).send({ success: false, error: 'rcon password must be a short string' });
            }
            if (body.rconPassword) {
              patch.rconPassword = body.rconPassword;
            } else {
              await ctx.collection('cs16_settings').update(
                { serverId: server.id }, { $unset: { rconPassword: '' } },
              ).catch(() => {});
            }
          }
          if (Object.keys(patch).length === 0 && body.rconPassword === undefined) {
            return reply.status(400).send({ success: false, error: 'nothing to update' });
          }
          if (Object.keys(patch).length > 0) {
            patch.updatedAt = new Date().toISOString();
            const existing = await ctx.collection('cs16_settings').findOne({ serverId: server.id });
            if (existing) {
              await ctx.collection('cs16_settings').update({ serverId: server.id }, { $set: patch });
            } else {
              await ctx.collection('cs16_settings').insert({ serverId: server.id, ...patch });
            }
          }
          // Settings changes are audited too (password values never logged).
          await recordAction(ctx, {
            serverId: server.id,
            action: 'settings',
            command: 'settings',
            detail: Object.keys(patch).filter((k) => k !== 'updatedAt').join(', ') || 'no changes',
            createdBy: getUserId(ctx, request),
          });
          return { success: true, settings: await getSettings(ctx, server.id) };
        } catch (err) {
          return sendError(reply, err);
        }
      },
    });

    // Effective transport + RCON availability (no probing; use rcon-test to probe).
    ctx.registerRoute({
      method: 'GET',
      url: '/servers/:id/transport',
      preHandler: requireRead(),
      handler: async (request, reply) => {
        try {
          const server = await loadServer(ctx, request.params.id);
          const settings = await getSettings(ctx, server.id);
          const secret = await getRconSecret(ctx, server.id);
          const rcon = await resolveRcon(ctx, server, { ...settings, rconPassword: secret });
          return {
            success: true,
            transport: TRANSPORTS.has(settings.transport) ? settings.transport : 'auto',
            rcon: {
              available: rcon.available,
              reason: rcon.available ? null : rcon.reason,
              source: rcon.available ? rcon.source : null,
              host: rcon.available ? rcon.host : null,
              port: rcon.available ? rcon.port : null,
            },
          };
        } catch (err) {
          return sendError(reply, err);
        }
      },
    });

    // Probe RCON with a harmless `version` command.
    ctx.registerRoute({
      method: 'POST',
      url: '/servers/:id/rcon-test',
      preHandler: requireWrite(),
      handler: async (request, reply) => {
        try {
          const server = await loadServer(ctx, request.params.id);
          const settings = await getSettings(ctx, server.id);
          const secret = await getRconSecret(ctx, server.id);
          const rcon = await resolveRcon(ctx, server, { ...settings, rconPassword: secret });
          if (!rcon.available) {
            return reply.status(400).send({ success: false, error: `rcon unavailable: ${rcon.reason}` });
          }
          const started = Date.now();
          const output = await rconCommand({
            host: rcon.host, port: rcon.port, password: rcon.password, command: 'version',
          });
          await recordAction(ctx, {
            serverId: server.id,
            action: 'rcon-test',
            command: 'version',
            target: `${rcon.host}:${rcon.port}`,
            createdBy: getUserId(ctx, request),
            transport: 'rcon',
          });
          return {
            success: true,
            host: rcon.host,
            port: rcon.port,
            source: rcon.source,
            latencyMs: Date.now() - started,
            output: String(output || '').slice(0, 2000),
          };
        } catch (err) {
          return sendError(reply, err);
        }
      },
    });

    // Ask the server for a fresh `status` dump. Over RCON the dump comes back
    // in the response so the tab can parse players immediately; over stdin it
    // arrives through the live console stream as before.
    ctx.registerRoute({
      method: 'POST',
      url: '/servers/:id/refresh-players',
      preHandler: requireWrite(),
      handler: async (request, reply) => {
        try {
          const server = await loadServer(ctx, request.params.id);
          const settings = await getSettings(ctx, server.id);
          const secret = await getRconSecret(ctx, server.id);
          const res = await sendConsole(ctx, server, buildStatus(), { ...settings, rconPassword: secret }, { wantOutput: true });
          await recordAction(ctx, {
            serverId: server.id, action: 'refresh-players', command: res.command,
            createdBy: getUserId(ctx, request), transport: res.transport,
          });
          return { success: true, sent: res.command, transport: res.transport, status: res.output };
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
          const settings = await getSettings(ctx, server.id);
          const secret = await getRconSecret(ctx, server.id);
          const res = await sendConsole(
            ctx, server, String(request.body?.command || ''),
            { ...settings, rconPassword: secret },
          );
          await recordAction(ctx, {
            serverId: server.id, action: 'command', command: res.command,
            createdBy: getUserId(ctx, request), transport: res.transport,
          });
          ctx.emitTyped?.('cs16-admin:command-sent', { serverId: server.id, command: res.command });
          return { success: true, sent: res.command, transport: res.transport, output: res.output ?? null };
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
          const secret = await getRconSecret(ctx, server.id);
          const body = request.body ?? {};
          const useAmx = body.useAmx ?? settings.useAmx ?? false;
          const res = await sendConsole(
            ctx, server,
            buildSay(String(body.message || ''), { team: Boolean(body.team), useAmx: Boolean(useAmx) }),
            { ...settings, rconPassword: secret },
          );
          await recordAction(ctx, {
            serverId: server.id, action: 'say', command: res.command,
            detail: body.team ? 'team' : 'all', createdBy: getUserId(ctx, request),
            transport: res.transport,
          });
          return { success: true, sent: res.command, transport: res.transport };
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
          const secret = await getRconSecret(ctx, server.id);
          const body = request.body ?? {};
          const useAmx = body.useAmx ?? settings.useAmx ?? false;
          const res = await sendConsole(
            ctx, server,
            buildKick({ userid: body.userid, name: body.name, reason: body.reason, useAmx: Boolean(useAmx) }),
            { ...settings, rconPassword: secret },
          );
          const target = body.userid || body.name || body.steamId || 'unknown';
          await recordAction(ctx, {
            serverId: server.id, action: 'kick', command: res.command, target,
            detail: body.reason || null, createdBy: getUserId(ctx, request),
            transport: res.transport,
          });
          ctx.emitTyped?.('cs16-admin:player-kicked', { serverId: server.id, steamId: String(body.steamId || target) });
          return { success: true, sent: res.command, transport: res.transport };
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
          const secret = await getRconSecret(ctx, server.id);
          const body = request.body ?? {};
          const useAmx = body.useAmx ?? settings.useAmx ?? false;
          const minutes = normalizeMinutes(body.minutes ?? settings.defaultBanMinutes, DEFAULT_BAN_MINUTES);
          const res = await sendConsole(
            ctx, server,
            buildBan({ steamId: body.steamId, name: body.name, minutes, reason: body.reason, useAmx: Boolean(useAmx) }),
            { ...settings, rconPassword: secret },
          );
          const createdBy = getUserId(ctx, request);
          const ban = {
            id: `ban_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
            serverId: server.id,
            name: String(body.name || '').slice(0, 48) || null,
            steamId: String(body.steamId || '').trim().toUpperCase(),
            minutes,
            reason: String(body.reason || '').slice(0, 128) || null,
            command: res.command,
            status: 'active',
            createdBy,
            createdAt: new Date().toISOString(),
          };
          await ctx.collection('cs16_bans').insert(ban);
          await recordAction(ctx, {
            serverId: server.id, action: 'ban', command: res.command, target: ban.steamId,
            detail: ban.reason, createdBy, transport: res.transport,
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
          return { success: true, sent: res.command, transport: res.transport, ban };
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
          const secret = await getRconSecret(ctx, server.id);
          const body = request.body ?? {};
          const useAmx = body.useAmx ?? settings.useAmx ?? false;
          const steamId = String(body.steamId || '').trim().toUpperCase();
          const res = await sendConsole(
            ctx, server, buildUnban({ steamId, useAmx: Boolean(useAmx) }),
            { ...settings, rconPassword: secret },
          );
          await ctx.collection('cs16_bans').update(
            { serverId: server.id, steamId, status: 'active' },
            { $set: { status: 'unbanned', unbannedAt: new Date().toISOString() } },
          );
          await recordAction(ctx, {
            serverId: server.id, action: 'unban', command: res.command, target: steamId,
            createdBy: getUserId(ctx, request), transport: res.transport,
          });
          return { success: true, sent: res.command, transport: res.transport };
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
          const secret = await getRconSecret(ctx, server.id);
          const body = request.body ?? {};
          const useAmx = body.useAmx ?? settings.useAmx ?? false;
          const res = await sendConsole(
            ctx, server, buildMap(String(body.map || ''), { useAmx: Boolean(useAmx) }),
            { ...settings, rconPassword: secret },
          );
          await recordAction(ctx, {
            serverId: server.id, action: 'map', command: res.command, target: String(body.map || ''),
            createdBy: getUserId(ctx, request), transport: res.transport,
          });
          ctx.emitTyped?.('cs16-admin:map-changed', { serverId: server.id, map: String(body.map || '') });
          return { success: true, sent: res.command, transport: res.transport };
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
          const settings = await getSettings(ctx, server.id);
          const secret = await getRconSecret(ctx, server.id);
          const res = await sendConsole(
            ctx, server, buildRestart(request.body?.seconds),
            { ...settings, rconPassword: secret },
          );
          await recordAction(ctx, {
            serverId: server.id, action: 'restart', command: res.command,
            createdBy: getUserId(ctx, request), transport: res.transport,
          });
          return { success: true, sent: res.command, transport: res.transport };
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
          const settings = await getSettings(ctx, server.id);
          const secret = await getRconSecret(ctx, server.id);
          const body = request.body ?? {};
          if (!ALLOWED_CVARS.has(String(body.cvar))) {
            return reply.status(400).send({ success: false, error: `cvar not allowed: ${body.cvar}` });
          }
          const res = await sendConsole(
            ctx, server, buildCvar(String(body.cvar), body.value),
            { ...settings, rconPassword: secret },
          );
          await recordAction(ctx, {
            serverId: server.id, action: 'cvar', command: res.command, target: String(body.cvar),
            detail: String(body.value ?? ''), createdBy: getUserId(ctx, request),
            transport: res.transport,
          });
          return { success: true, sent: res.command, transport: res.transport };
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
          const settings = await getSettings(ctx, server.id);
          const secret = await getRconSecret(ctx, server.id);
          const body = request.body ?? {};
          const res = await sendConsole(
            ctx, server, buildAmxAction(String(body.action || ''), body.target, body.extra),
            { ...settings, rconPassword: secret },
          );
          await recordAction(ctx, {
            serverId: server.id, action: `amx_${body.action}`, command: res.command,
            target: String(body.target || ''), createdBy: getUserId(ctx, request),
            transport: res.transport,
          });
          return { success: true, sent: res.command, transport: res.transport };
        } catch (err) {
          return sendError(reply, err);
        }
      },
    });

    // Audit log: every action taken through this tab, filterable by actor,
    // action type, free text and date range, with pagination.
    // GET /servers/:id/actions?user=&action=&search=&from=YYYY-MM-DD&to=YYYY-MM-DD&page=&pageSize=
    ctx.registerRoute({
      method: 'GET',
      url: '/servers/:id/actions',
      preHandler: requireRead(),
      handler: async (request, reply) => {
        try {
          const server = await loadServer(ctx, request.params.id);
          const q = request.query ?? {};
          const all = await backfillActorNames(
            ctx,
            await ctx.collection('cs16_actions').find(
              { serverId: server.id }, { sort: { createdAt: -1 } },
            ),
          );
          const filtered = applyActionFilters(all, {
            user: q.user, action: q.action, search: q.search, from: q.from, to: q.to,
          });
          // Legacy callers pass only `limit`: behave like page 1 of that size.
          const pageSize = q.page || q.pageSize
            ? q.pageSize
            : Math.min(MAX_ACTIONS_RETURNED, Math.max(1, Number(q.limit) || 30));
          const page = paginateActions(filtered, q.page || 1, pageSize);
          return {
            success: true,
            actions: page.items,
            total: page.total,
            page: page.page,
            pageSize: page.pageSize,
            users: distinctActors(all),
          };
        } catch (err) {
          return sendError(reply, err);
        }
      },
    });

    // Export the filtered audit log as CSV (same filters as the list).
    ctx.registerRoute({
      method: 'GET',
      url: '/servers/:id/actions.csv',
      preHandler: requireRead(),
      handler: async (request, reply) => {
        try {
          const server = await loadServer(ctx, request.params.id);
          const q = request.query ?? {};
          const all = await backfillActorNames(
            ctx,
            await ctx.collection('cs16_actions').find(
              { serverId: server.id }, { sort: { createdAt: -1 } },
            ),
          );
          const filtered = applyActionFilters(all, {
            user: q.user, action: q.action, search: q.search, from: q.from, to: q.to,
          }).slice(0, MAX_AUDIT_PER_SERVER);
          const csv = actionsToCsv(filtered);
          return reply
            .header('Content-Type', 'text/csv; charset=utf-8')
            .header('Content-Disposition', `attachment; filename="cs16-audit-${server.id}.csv"`)
            .send(csv);
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
