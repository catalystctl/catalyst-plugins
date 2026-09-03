/**
 * AI Assistant — Catalyst tool definitions + executors.
 *
 * The model only ever sees plain JSON schemas; every executor runs
 * server-side with the requesting user's permissions already checked by the
 * chat route. Secrets in environment variables are masked before they reach
 * the model or the browser.
 */

const SECRET_KEY = /(secret|password|passwd|token|api[_-]?key|private|credential)/i;

export function maskEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    out[k] = SECRET_KEY.test(k) ? '*** (redacted)' : v;
  }
  return out;
}

function serverSummary(s) {
  return {
    id: s.id,
    uuid: s.uuid,
    name: s.name,
    status: s.status,
    nodeId: s.nodeId,
    templateId: s.templateId,
    primaryIp: s.primaryIp ?? null,
    primaryPort: s.primaryPort ?? null,
    allocatedMemoryMb: s.allocatedMemoryMb,
    allocatedCpuCores: s.allocatedCpuCores,
    allocatedDiskMb: s.allocatedDiskMb,
  };
}

function serverDetails(s) {
  return {
    ...serverSummary(s),
    description: s.description ?? null,
    startupCommand: s.startupCommand ?? null,
    environment: maskEnv(s.environment || {}),
    containerId: s.containerId ?? null,
    containerName: s.containerName ?? null,
    networkMode: s.networkMode ?? null,
    crashCount: s.crashCount ?? 0,
    lastCrashAt: s.lastCrashAt ?? null,
    lastExitCode: s.lastExitCode ?? null,
    restartPolicy: s.restartPolicy ?? null,
    suspendedAt: s.suspendedAt ?? null,
    suspensionReason: s.suspensionReason ?? null,
    createdAt: s.createdAt ?? null,
    updatedAt: s.updatedAt ?? null,
  };
}

/** Normalize the agent's list payload (array, {entries}, or {files}). */
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
    .map((e) => ({
      name: String(e.name ?? ''),
      isDirectory: Boolean(e.isDirectory ?? e.is_dir ?? e.type === 'directory'),
      size: Number(e.size ?? 0) || 0,
      modified: e.modifiedAt ?? e.modified ?? e.mtime ?? null,
    }))
    .filter((e) => e.name);
}

export function toolDefinitions({ allowReads, allowWrites }) {
  const tools = [
    {
      name: 'list_servers',
      description: 'List game servers visible to the panel (name, status, node, allocations). Call first when the user asks about a server without giving its exact id.',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Optional case-insensitive substring to filter by server name' },
        },
      },
    },
    {
      name: 'get_server',
      description: 'Full details for one server: startup command, environment variables (secrets redacted), allocations, crash counters. Use before diagnosing a specific server.',
      parameters: {
        type: 'object',
        properties: {
          serverId: { type: 'string', description: 'Server id or uuid (or exact name as fallback)' },
        },
        required: ['serverId'],
      },
    },
  ];
  if (allowReads) {
    tools.push(
      {
        name: 'list_files',
        description: 'List files in a server directory via the file tunnel. Use to find configs (server.properties, server.cfg) and logs (logs/latest.log).',
        parameters: {
          type: 'object',
          properties: {
            serverId: { type: 'string', description: 'Server id or uuid' },
            path: { type: 'string', description: 'Directory path, e.g. "/" or "/logs". Defaults to "/".' },
          },
          required: ['serverId'],
        },
      },
      {
        name: 'read_file',
        description: 'Read a text file from a server (truncated). Prefer it over guessing config contents.',
        parameters: {
          type: 'object',
          properties: {
            serverId: { type: 'string', description: 'Server id or uuid' },
            path: { type: 'string', description: 'File path, e.g. "/server.properties" or "/logs/latest.log"' },
            maxKb: { type: 'number', description: 'Max kilobytes to return (defaults to the plugin maxFileReadKb setting)' },
          },
          required: ['serverId', 'path'],
        },
      },
    );
  }
  if (allowWrites) {
    tools.push({
      name: 'write_file',
      description: 'Overwrite a text file on a server. Only call after telling the user exactly what will change and why.',
      parameters: {
        type: 'object',
        properties: {
          serverId: { type: 'string', description: 'Server id or uuid' },
          path: { type: 'string', description: 'File path to overwrite' },
          content: { type: 'string', description: 'Full new file content (UTF-8 text)' },
        },
        required: ['serverId', 'path', 'content'],
      },
    });
  }
  return tools;
}

/**
 * Resolve a user-supplied server reference (id, uuid, or exact name) to a
 * full server row through the scoped plugin DB.
 */
export async function resolveServer(ctx, ref) {
  const want = String(ref || '').trim();
  if (!want) throw new Error('serverId is required');
  const select = {
    id: true, uuid: true, name: true, description: true, status: true,
    nodeId: true, templateId: true, primaryIp: true, primaryPort: true,
    allocatedMemoryMb: true, allocatedCpuCores: true, allocatedDiskMb: true,
    environment: true, startupCommand: true, containerId: true,
    containerName: true, networkMode: true, crashCount: true,
    lastCrashAt: true, lastExitCode: true, restartPolicy: true,
    suspendedAt: true, suspensionReason: true, createdAt: true, updatedAt: true,
  };
  // Direct id lookup, then uuid lookup, then name scan (bounded).
  try {
    const byId = await ctx.db.servers.findUnique({ where: { id: want }, select });
    if (byId) return byId;
  } catch { /* not found by id — try uuid */ }
  try {
    const byUuid = await ctx.db.servers.findUnique({ where: { uuid: want }, select });
    if (byUuid) return byUuid;
  } catch { /* fall through to scan */ }
  const all = await ctx.db.servers.findMany({ select, take: 200 });
  const exact = all.find((s) => s.name === want || s.uuid === want || s.id === want);
  if (exact) return exact;
  const partial = all.filter((s) => s.name.toLowerCase().includes(want.toLowerCase()));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(`"${want}" matches ${partial.length} servers (${partial.slice(0, 5).map((s) => s.name).join(', ')}). Ask the user to pick one.`);
  }
  throw new Error(`server "${want}" not found`);
}

/**
 * Build an executor bound to one chat request. File operations go through
 * the panel file tunnel; missing tunnels and oversized binaries become
 * plain-text tool results (never exceptions the model cannot see).
 */
export function createToolExecutor(ctx, { maxFileReadKb }) {
  async function tunnel() {
    const t = ctx.fileTunnel;
    if (!t) throw new Error('fileTunnel not available — the panel host did not expose file access to plugins');
    return t;
  }

  return {
    async execute(name, args = {}) {
      try {
        if (name === 'list_servers') {
          const servers = await ctx.db.servers.findMany({
            select: {
              id: true, uuid: true, name: true, status: true, nodeId: true,
              templateId: true, primaryIp: true, primaryPort: true,
              allocatedMemoryMb: true, allocatedCpuCores: true, allocatedDiskMb: true,
            },
            take: 200,
            orderBy: { name: 'asc' },
          });
          const q = String(args.search || '').toLowerCase();
          const filtered = q ? servers.filter((s) => s.name.toLowerCase().includes(q)) : servers;
          return JSON.stringify(filtered.map(serverSummary).slice(0, 50));
        }
        if (name === 'get_server') {
          const s = await resolveServer(ctx, args.serverId);
          return JSON.stringify(serverDetails(s));
        }
        if (name === 'list_files') {
          const s = await resolveServer(ctx, args.serverId);
          const t = await tunnel();
          const dir = String(args.path || '/');
          const res = await t.queueRequest(s.nodeId, 'list', s.uuid, dir);
          if (!res.success) return `list ${dir} failed: ${res.error || 'unknown error'}`;
          const entries = listEntries(res.data).slice(0, 200);
          return JSON.stringify({ path: dir, entries });
        }
        if (name === 'read_file') {
          const s = await resolveServer(ctx, args.serverId);
          const t = await tunnel();
          const filePath = String(args.path || '');
          if (!filePath || filePath === '/') return 'read_file needs a file path, not a directory';
          const capKb = Math.min(Number(args.maxKb) || maxFileReadKb, maxFileReadKb * 2);
          const res = await t.queueRequest(s.nodeId, 'download', s.uuid, filePath);
          if (!res.success || !res.body) return `read ${filePath} failed: ${res.error || 'empty body (node offline?)'}`;
          const buf = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body);
          if (buf.includes(0)) return `read ${filePath}: binary file (${buf.length} bytes), not shown`;
          let text = buf.toString('utf8');
          const truncated = text.length > capKb * 1024;
          if (truncated) {
            text = text.slice(-capKb * 1024);
            text = `…(truncated, showing last ${capKb}KB of ${buf.length} bytes)…\n` + text;
          }
          return text || '(empty file)';
        }
        if (name === 'write_file') {
          const s = await resolveServer(ctx, args.serverId);
          const t = await tunnel();
          const filePath = String(args.path || '');
          const content = String(args.content ?? '');
          if (!filePath || filePath === '/') return 'write_file needs a file path, not a directory';
          if (!content) return 'write_file needs non-empty content';
          if (Buffer.byteLength(content, 'utf8') > 1024 * 1024) return 'write_file refused: content over 1MB';
          const res = await t.queueRequest(s.nodeId, 'write', s.uuid, filePath, { content });
          if (!res.success) return `write ${filePath} failed: ${res.error || 'unknown error'}`;
          return `wrote ${filePath} (${Buffer.byteLength(content, 'utf8')} bytes)`;
        }
        return `unknown tool "${name}"`;
      } catch (err) {
        return `tool ${name} error: ${err?.message || String(err)}`;
      }
    },
  };
}
