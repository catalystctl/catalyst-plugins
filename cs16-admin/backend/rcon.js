/**
 * CS 1.6 Admin — GoldSrc RCON client over UDP.
 * Pure Node (node:dgram), no dependencies.
 *
 * GoldSrc (HLDS/ReHLDS) speaks the classic challenge-based RCON protocol:
 *   -> 0xFFFFFFFF "challenge rcon"
 *   <- 0xFFFFFFFF "challenge rcon <id>"
 *   -> 0xFFFFFFFF "rcon <id> <password> <command>"
 *   <- 0xFFFFFFFF "<output...>" (one packet, or a burst for long output
 *      such as `status` — packets have no sequence numbers, so the burst is
 *      reassembled in arrival order until a quiet period ends it)
 */

import dgram from 'node:dgram';

const PREFIX = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const CHALLENGE_TIMEOUT_MS = 3000;
const COMMAND_TIMEOUT_MS = 3000;
// Long outputs (status) arrive as a burst: keep collecting until this long
// after the last packet, with a hard cap on the whole collection.
const BURST_QUIET_MS = 350;
const BURST_MAX_MS = 2000;

export function buildPacket(body) {
  return Buffer.concat([PREFIX, Buffer.from(`${body}\n`, 'latin1')]);
}

export function stripPrefix(packet) {
  const buf = Buffer.isBuffer(packet) ? packet : Buffer.from(packet);
  const start = buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xff && buf[2] === 0xff && buf[3] === 0xff ? 4 : 0;
  return buf.subarray(start).toString('latin1').replace(/\0+$/g, '').replace(/\n+$/g, '\n');
}

export function parseChallenge(text) {
  const m = String(text || '').match(/challenge\s+rcon\s+(\d+)/i);
  if (!m) throw new Error('rcon challenge rejected (is rcon enabled on the server?)');
  return m[1];
}

function quotePassword(password) {
  const raw = String(password || '');
  if (!raw) throw new Error('rcon password is required');
  if (/[\r\n]/.test(raw)) throw new Error('rcon password contains disallowed characters');
  return /[\s"]/.test(raw) ? `"${raw.replace(/"/g, '')}"` : raw;
}

function sendOnce(socket, host, port, packet, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeAllListeners('message');
      reject(new Error(`rcon timeout contacting ${host}:${port} (UDP unreachable or wrong port?)`));
    }, timeoutMs);
    const onMessage = (msg) => {
      clearTimeout(timer);
      socket.removeListener('message', onMessage);
      resolve(msg);
    };
    socket.on('message', onMessage);
    socket.send(packet, port, host, (err) => {
      if (err) {
        clearTimeout(timer);
        socket.removeListener('message', onMessage);
        reject(err);
      }
    });
  });
}

/**
 * Run one RCON command. Resolves with the server's raw text response.
 * Fetches a fresh challenge per call (low-frequency admin traffic) and
 * retries once on a stale-challenge rejection.
 */
export async function rconCommand({ host, port, password, command, timeoutMs = COMMAND_TIMEOUT_MS }) {
  if (!host) throw new Error('rcon host is required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('rcon port is invalid');
  const cleanCommand = String(command || '').trim();
  if (!cleanCommand) throw new Error('command is required');
  const quoted = quotePassword(password);

  const socket = dgram.createSocket('udp4');
  try {
    const attempt = async (challenge) => {
      const packet = buildPacket(`rcon ${challenge} ${quoted} ${cleanCommand}`);
      return collectBurst(socket, host, port, packet, timeoutMs);
    };

    const challengeRaw = stripPrefix(await sendOnce(socket, host, port, buildPacket('challenge rcon'), timeoutMs));
    let challenge;
    try {
      challenge = parseChallenge(challengeRaw);
    } catch (err) {
      if (/Bad rcon_password|Bad challenge/i.test(challengeRaw)) {
        throw new Error('rcon rejected the challenge request (wrong game port?)');
      }
      throw err;
    }

    let output = await attempt(challenge);
    if (/^Bad challenge\b/i.test(output.trim()) || /^Bad rcon_password\b/i.test(output.trim())) {
      // One retry with a fresh challenge covers challenge rotation races.
      if (/^Bad rcon_password\b/i.test(output.trim())) {
        throw new Error('rcon authentication failed (wrong password)');
      }
      const retryRaw = stripPrefix(await sendOnce(socket, host, port, buildPacket('challenge rcon'), timeoutMs));
      output = await attempt(parseChallenge(retryRaw));
      if (/^Bad rcon_password\b/i.test(output.trim())) {
        throw new Error('rcon authentication failed (wrong password)');
      }
    }
    return output;
  } finally {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }
}

/** Send a packet and collect the response burst until a quiet period ends it. */
async function collectBurst(socket, host, port, packet, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const started = Date.now();
    let quietTimer = null;
    let hardTimer = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (quietTimer) clearTimeout(quietTimer);
      if (hardTimer) clearTimeout(hardTimer);
      socket.removeListener('message', onMessage);
      if (chunks.length === 0) {
        reject(new Error(`rcon timeout contacting ${host}:${port} (UDP unreachable or wrong port?)`));
        return;
      }
      resolve(chunks.join(''));
    };

    const armQuiet = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, BURST_QUIET_MS);
    };

    const onMessage = (msg) => {
      chunks.push(stripPrefix(msg));
      if (Date.now() - started > BURST_MAX_MS) {
        finish();
        return;
      }
      armQuiet();
    };

    hardTimer = setTimeout(finish, timeoutMs + BURST_MAX_MS);
    socket.on('message', onMessage);
    socket.send(packet, port, host, (err) => {
      if (err) {
        if (!settled) {
          settled = true;
          if (quietTimer) clearTimeout(quietTimer);
          if (hardTimer) clearTimeout(hardTimer);
          socket.removeListener('message', onMessage);
          reject(err);
        }
        return;
      }
      armQuiet();
    });
  });
}

/**
 * Extract rcon_password from a server.cfg-style file.
 * Returns the password or null when unset/empty. Ignores // comments.
 */
export function parseRconPassword(cfgText) {
  for (const rawLine of String(cfgText || '').split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, '');
    const m = line.match(/^\s*rcon_password\s+(?:"([^"]*)"|(\S+))\s*$/i);
    if (m) {
      const value = (m[1] ?? m[2] ?? '').trim();
      return value || null;
    }
  }
  return null;
}
