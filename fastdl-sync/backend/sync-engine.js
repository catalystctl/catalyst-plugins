/**
 * FastDL sync — I/O engine.
 *
 * Talks to agents exclusively through the panel's file tunnel
 * (context.fileTunnel.queueRequest): `list` to walk source trees, `download`
 * to read source files (streamed response body), `upload` to write them into
 * the FastDL server's docroot, `delete` for removals.
 *
 * All tree-shape decisions come from ./logic.js (pure, unit-tested).
 */

import { isDownloadableContent, gameDirOf, diffFileLists } from './logic.js';

const DOWNLOADABLE_TOP_DIRS = [
  'maps', 'models', 'sprites', 'resource', 'materials', 'particles',
  'sound', 'media', 'fonts', 'overviews', 'events', 'gfx',
];

/**
 * The agent returns `data` as the file array itself (see file_tunnel.rs
 * handle_list). `{ entries: [...] }` is accepted too. Never read
 * `data.entries` on an array — that's Array.prototype.entries, a function,
 * which produced "entries.filter is not a function".
 */
export function listEntries(data) {
  const raw = Array.isArray(data)
    ? data
    : Array.isArray(data?.entries)
      ? data.entries
      : Array.isArray(data?.files)
        ? data.files
        : [];
  return raw
    .filter((e) => e && typeof e === 'object')
    .map((e) => {
      const name = String(e.name ?? '');
      const isDirectory = Boolean(e.isDirectory ?? e.is_dir ?? e.type === 'directory');
      const size = Number(e.size ?? 0) || 0;
      const modified = e.modifiedAt ?? e.modified ?? e.mtime;
      const mtimeMs = modified ? Date.parse(modified) || 0 : 0;
      return { name, isDirectory, size, mtimeMs };
    })
    .filter((e) => e.name);
}

/**
 * Walk a server's downloadable content via the file tunnel.
 * Returns Map<relPath, {size, mtimeMs}> of downloadable files only.
 *
 * @param {PluginFileTunnel-like} tunnel  context.fileTunnel
 * @param {string} nodeId
 * @param {string} serverUuid
 * @param {{ maxFileSizeMb?: number, logger?: object }} opts
 */
export async function scanServerContent(tunnel, nodeId, serverUuid, opts = {}) {
  const maxBytes = (opts.maxFileSizeMb ?? 512) * 1024 * 1024;
  const files = new Map();

  // Discover game dirs: the data root's immediate subdirectories that look
  // like mod dirs (contain any content dir or a .wad).
  const rootList = await tunnel.queueRequest(nodeId, 'list', serverUuid, '.');
  if (!rootList.success) throw new Error(`list root failed: ${rootList.error}`);
  const gameDirs = listEntries(rootList.data).filter((e) => e.isDirectory);

  for (const gd of gameDirs) {
    // 1. Root .wad files of this game dir
    const gdList = await tunnel.queueRequest(nodeId, 'list', serverUuid, gd.name);
    if (gdList.success) {
      for (const f of listEntries(gdList.data)) {
        if (!f.isDirectory && f.name.toLowerCase().endsWith('.wad') && f.size <= maxBytes) {
          files.set(`${gd.name}/${f.name}`, { size: f.size, mtimeMs: f.mtimeMs });
        }
      }
    }

    // 2. Content directories
    for (const dir of DOWNLOADABLE_TOP_DIRS) {
      const files2 = await walkTunnel(tunnel, nodeId, serverUuid, `${gd.name}/${dir}`, maxBytes, 0);
      for (const [p, stat] of files2) files.set(p, stat);
    }
  }

  // Filter through the same classification the copier uses (denylists etc.)
  for (const p of [...files.keys()]) {
    if (!isDownloadableContent(p)) files.delete(p);
  }
  return files;
}

/** Recursive tunnel walk capped at depth 6 (maps/... rarely go deeper). */
async function walkTunnel(tunnel, nodeId, serverUuid, dirPath, maxBytes, depth) {
  const out = new Map();
  if (depth > 6) return out;
  let res;
  try {
    res = await tunnel.queueRequest(nodeId, 'list', serverUuid, dirPath);
  } catch {
    return out; // missing dir — normal
  }
  if (!res.success) return out;

  for (const e of listEntries(res.data)) {
    const child = `${dirPath}/${e.name}`;
    if (e.isDirectory) {
      const sub = await walkTunnel(tunnel, nodeId, serverUuid, child, maxBytes, depth + 1);
      for (const [p, stat] of sub) out.set(p, stat);
    } else if (e.size <= maxBytes) {
      out.set(child, { size: e.size, mtimeMs: e.mtimeMs });
    }
  }
  return out;
}

/**
 * Pairings persist `sourceServerNodeId` / `fastdlServerNodeId` (see backend/index.js).
 * Accept the shorter aliases too so a renamed field cannot silently no-op sync.
 */
export function resolvePairingNodes(pairing) {
  const sourceNodeId = pairing?.sourceServerNodeId || pairing?.sourceNodeId || null;
  const fastdlNodeId = pairing?.fastdlServerNodeId || pairing?.fastdlNodeId || null;
  const sourceServerUuid = pairing?.sourceServerUuid || null;
  const fastdlServerUuid = pairing?.fastdlServerUuid || null;
  const missing = [];
  if (!sourceNodeId) missing.push('sourceServerNodeId');
  if (!fastdlNodeId) missing.push('fastdlServerNodeId');
  if (!sourceServerUuid) missing.push('sourceServerUuid');
  if (!fastdlServerUuid) missing.push('fastdlServerUuid');
  return { sourceNodeId, fastdlNodeId, sourceServerUuid, fastdlServerUuid, missing };
}

/**
 * Run one sync pass for a pairing. Returns a per-run report.
 *
 * @param {object} ctx  plugin context
 * @param {object} pairing  { id, sourceServerUuid, sourceServerNodeId, fastdlServerUuid, fastdlServerNodeId }
 * @param {object} opts  { generateBzip2, bz2MinSizeMb, deleteRemoved, maxFileSizeMb }
 */
export async function syncPairing(ctx, pairing, opts) {
  const tunnel = ctx.fileTunnel;
  if (!tunnel) throw new Error('fileTunnel not available — host does not expose the file tunnel to plugins');

  const startedAt = new Date().toISOString();
  const report = {
    pairingId: pairing.id,
    startedAt,
    finishedAt: null,
    ok: false,
    copied: 0,
    deleted: 0,
    bz2Generated: 0,
    skipped: 0,
    errors: [],
  };

  try {
    const nodes = resolvePairingNodes(pairing);
    if (nodes.missing.length) {
      throw new Error(`pairing is missing ${nodes.missing.join(', ')}`);
    }

    // 1. Scan source
    const source = await scanServerContent(tunnel, nodes.sourceNodeId, nodes.sourceServerUuid, opts);

    // 2. Load last-synced state (per pairing)
    const stateDoc = await ctx.collection('sync_state').findOne({ pairingId: pairing.id });
    const state = stateDoc?.files ?? {};
    const { toCopy, toDelete } = diffFileLists(source, state);

    // 3. Copy new/changed files: download from source, upload into FastDL
    for (const relPath of toCopy) {
      try {
        const dl = await tunnel.queueRequest(nodes.sourceNodeId, 'download', nodes.sourceServerUuid, relPath);
        if (!dl.success || !dl.body) {
          report.errors.push(`download ${relPath}: ${dl.error ?? 'empty body'}`);
          report.skipped++;
          continue;
        }
        const target = `fastdl/${relPath}`;
        const up = await tunnel.queueRequest(
          nodes.fastdlNodeId, 'upload', nodes.fastdlServerUuid, target, {}, dl.body,
        );
        if (!up.success) {
          report.errors.push(`upload ${target}: ${up.error ?? 'failed'}`);
          report.skipped++;
          continue;
        }
        report.copied++;

        // 4. Optional .bz2 twin (HL1 engines fetch file.bz2 automatically)
        if (opts.generateBzip2) {
          const minBytes = (opts.bz2MinSizeMb ?? 2) * 1024 * 1024;
          const stat = source.get(relPath);
          if (stat && stat.size >= minBytes && !relPath.toLowerCase().endsWith('.bz2')) {
            try {
              const { bzip2Compress } = await import('./bzip2.js');
              const bz2 = await bzip2Compress(dl.body);
              const up2 = await tunnel.queueRequest(
                nodes.fastdlNodeId, 'upload', nodes.fastdlServerUuid, `${target}.bz2`, {}, bz2,
              );
              if (up2.success) report.bz2Generated++;
            } catch (err) {
              report.errors.push(`bz2 ${relPath}: ${err.message}`);
            }
          }
        }
      } catch (err) {
        report.errors.push(`${relPath}: ${err.message}`);
        report.skipped++;
      }
    }

    // 5. Handle removals (source file gone)
    if (opts.deleteRemoved) {
      for (const relPath of toDelete) {
        const target = `fastdl/${relPath}`;
        try {
          const del = await tunnel.queueRequest(nodes.fastdlNodeId, 'delete', nodes.fastdlServerUuid, target);
          if (del.success) {
            report.deleted++;
          } else {
            // Already absent is fine — treat as deleted.
            if (!/not found|no such/i.test(del.error ?? '')) {
              report.errors.push(`delete ${target}: ${del.error ?? 'failed'}`);
              continue;
            }
            report.deleted++;
          }
          // Remove any stale twin too.
          if (opts.generateBzip2) {
            await tunnel.queueRequest(
              nodes.fastdlNodeId, 'delete', nodes.fastdlServerUuid, `${target}.bz2`,
            ).catch(() => {});
          }
        } catch (err) {
          report.errors.push(`delete ${target}: ${err.message}`);
        }
      }
    }

    // 6. Persist the new snapshot only if fully successful, so partial
    //    failures retry next run instead of being forgotten.
    if (report.errors.length === 0) {
      const files = {};
      for (const [p, stat] of source) files[p] = stat;
      if (stateDoc) {
        await ctx.collection('sync_state').update({ pairingId: pairing.id }, { $set: { files, syncedAt: startedAt } });
      } else {
        await ctx.collection('sync_state').insert({ pairingId: pairing.id, files, syncedAt: startedAt });
      }
    }

    report.ok = report.errors.length === 0;
  } catch (err) {
    report.errors.push(err.message ?? String(err));
  }

  report.finishedAt = new Date().toISOString();
  return report;
}

/** Human summary for the sync log. Includes the first error so the pairing card
 *  shows it even when the UI only renders `summary` (not `errors[]`). */
export function summarizeReport(report) {
  const bits = [];
  bits.push(`${report.copied} copied`);
  if (report.bz2Generated) bits.push(`${report.bz2Generated} .bz2`);
  if (report.deleted) bits.push(`${report.deleted} deleted`);
  if (report.skipped) bits.push(`${report.skipped} skipped`);
  if (report.errors.length) {
    bits.push(`${report.errors.length} error${report.errors.length === 1 ? '' : 's'}: ${report.errors[0]}`);
  }
  return bits.join(', ');
}
