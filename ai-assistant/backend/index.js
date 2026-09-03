/**
 * AI Assistant — backend entry.
 *
 * A bring-your-own-model chat assistant for Catalyst: server configuration
 * help, file inspection via the file tunnel, and log diagnosis. Panel owners
 * configure any OpenAI Chat Completions / OpenAI Responses / Anthropic
 * Messages endpoint (URL + key + model + budgets) in the plugin settings.
 *
 * Storage (plugin collections):
 *   conversations — { id, serverId, userId, title, createdAt, updatedAt }
 *   messages      — { conversationId, role, content, toolTrace, createdAt }
 */

import { callProvider, pingProvider, estimateTokens } from './llm.js';
import { toolDefinitions, createToolExecutor, resolveServer, maskEnv } from './tools.js';

const DEFAULTS = {
  provider: 'openai-completions',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  contextWindowTokens: 128000,
  maxOutputTokens: 2048,
  temperature: 0.2,
  systemPrompt: 'You are the Catalyst panel AI assistant. Help admins configure game servers, diagnose crashes and read logs. Be concrete: cite file paths, config keys and exact values. When you are unsure, say what extra file or log line would confirm it. Never invent file contents you have not been shown via tools or pasted logs.',
  allowFileReads: true,
  allowFileWrites: false,
  maxFileReadKb: 200,
  maxToolIterations: 6,
};

const MAX_HISTORY_MESSAGES = 30;
const MAX_PASTED_CHARS = 120000;
const TOOL_RESULT_CHARS = 12000;

function cfg(ctx, key) {
  const v = ctx.getConfig(key);
  return v === undefined || v === null || v === '' ? DEFAULTS[key] : v;
}

function providerConfig(ctx) {
  return {
    provider: cfg(ctx, 'provider'),
    baseUrl: cfg(ctx, 'baseUrl'),
    apiKey: cfg(ctx, 'apiKey'),
    model: cfg(ctx, 'model'),
    contextWindowTokens: Math.max(4096, Number(cfg(ctx, 'contextWindowTokens')) || DEFAULTS.contextWindowTokens),
    maxOutputTokens: Math.min(16000, Math.max(256, Number(cfg(ctx, 'maxOutputTokens')) || DEFAULTS.maxOutputTokens)),
    temperature: Math.min(2, Math.max(0, Number(cfg(ctx, 'temperature')) || 0)),
  };
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function fail(reply, message, status = 400) {
  return reply.status(status).send({ success: false, error: message });
}

/** Fit history + server context + pasted logs into the model's window. */
function buildPrompt(ctx, { history, serverBlock, pastedLogs }) {
  const pcfg = providerConfig(ctx);
  const budget = Math.max(8000, pcfg.contextWindowTokens - pcfg.maxOutputTokens - 2000);
  const system = String(cfg(ctx, 'systemPrompt') || DEFAULTS.systemPrompt);

  let pasted = pastedLogs ? String(pastedLogs) : '';
  if (pasted.length > MAX_PASTED_CHARS) {
    pasted = `…(truncated, showing last ${Math.round(MAX_PASTED_CHARS / 1024)}KB)…\n` + pasted.slice(-MAX_PASTED_CHARS);
  }

  const blocks = [];
  if (serverBlock) blocks.push(`Server context (live from the panel):\n${serverBlock}`);
  if (pasted) blocks.push(`Logs pasted by the user for analysis:\n${pasted}`);
  const contextPreamble = blocks.length
    ? [{ role: 'user', content: blocks.join('\n\n').slice(0, 60000) }]
    : [];

  // Newest-first accumulation until the budget runs out, then re-chronologize.
  const kept = [];
  let used = estimateTokens(system) + estimateTokens(JSON.stringify(contextPreamble));
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const cost = estimateTokens(m.content) + 500;
    if (used + cost > budget) break;
    used += cost;
    kept.unshift({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 40000) });
  }
  return { system, preamble: contextPreamble, history: kept, truncated: kept.length < history.length };
}

async function serverContextBlock(ctx, serverId) {
  if (!serverId) return '';
  try {
    const s = await resolveServer(ctx, serverId);
    const env = maskEnv(s.environment || {});
    const keys = Object.keys(env).slice(0, 60);
    const envLines = keys.map((k) => `  ${k}=${String(env[k]).slice(0, 300)}`).join('\n');
    return [
      `name=${s.name} id=${s.id} uuid=${s.uuid} status=${s.status}`,
      `node=${s.nodeId} template=${s.templateId} ip=${s.primaryIp ?? '?'}:${s.primaryPort ?? '?'}`,
      `allocations: ${s.allocatedMemoryMb}MB RAM / ${s.allocatedCpuCores} CPU / ${s.allocatedDiskMb}MB disk`,
      `startup: ${s.startupCommand || '(default)'}`,
      `environment:\n${envLines || '  (none)'}`,
      `crashes: count=${s.crashCount ?? 0} lastExit=${s.lastExitCode ?? '?'} lastCrash=${s.lastCrashAt ?? 'never'}`,
    ].join('\n');
  } catch (err) {
    return `(could not load server "${serverId}": ${err.message})`;
  }
}

/** Agentic loop: call the model, run tool calls, repeat up to the cap. */
async function runChat(ctx, executor, tools, system, messages) {
  const maxIters = Math.min(10, Math.max(1, Number(cfg(ctx, 'maxToolIterations')) || DEFAULTS.maxToolIterations));
  const pcfg = providerConfig(ctx);
  const trace = [];
  const working = [...messages];

  for (let iter = 0; iter <= maxIters; iter++) {
    const step = await callProvider(pcfg, { system, messages: working, tools });
    const calls = step.toolCalls || [];
    if (!calls.length) return { text: step.text || '(empty reply)', trace };

    if (iter === maxIters) {
      working.push({ role: 'assistant', content: step.text || '', toolCalls: calls });
      for (const c of calls) {
        working.push({ role: 'tool', toolCallId: c.id, name: c.name, content: 'tool budget exhausted — answer with what you have' });
      }
      const final = await callProvider(pcfg, { system, messages: working, tools: [] });
      return { text: final.text || '(empty reply)', trace };
    }

    working.push({ role: 'assistant', content: step.text || '', toolCalls: calls });
    for (const c of calls) {
      const raw = await executor.execute(c.name, c.args);
      const content = raw.length > TOOL_RESULT_CHARS
        ? raw.slice(0, TOOL_RESULT_CHARS) + `\n…(truncated ${raw.length - TOOL_RESULT_CHARS} chars)…`
        : raw;
      trace.push({ tool: c.name, args: c.args, resultChars: raw.length, truncated: raw.length > TOOL_RESULT_CHARS });
      working.push({ role: 'tool', toolCallId: c.id, name: c.name, content });
    }
  }
  return { text: '(empty reply)', trace };
}

const plugin = {
  async onLoad(ctx) {
    ctx.logger.info('AI Assistant plugin loaded');
    const requireServerRead = (...perms) => ctx.requirePermission?.(...perms) ?? ((req, reply, done) => done?.());

    // ── Status (key never leaves the server) ──────────────────────────────
    ctx.registerRoute({
      method: 'GET',
      url: '/status',
      preHandler: requireServerRead('server.read'),
      handler: async () => {
        const pcfg = providerConfig(ctx);
        const key = String(pcfg.apiKey || '');
        return {
          success: true,
          provider: pcfg.provider,
          model: pcfg.model,
          baseUrl: pcfg.baseUrl,
          hasApiKey: key.length > 0,
          keySuffix: key.length > 4 ? `…${key.slice(-4)}` : null,
          contextWindowTokens: pcfg.contextWindowTokens,
          maxOutputTokens: pcfg.maxOutputTokens,
          temperature: pcfg.temperature,
          allowFileReads: Boolean(cfg(ctx, 'allowFileReads')),
          allowFileWrites: Boolean(cfg(ctx, 'allowFileWrites')),
          maxFileReadKb: Number(cfg(ctx, 'maxFileReadKb')) || DEFAULTS.maxFileReadKb,
          fileTunnelAvailable: Boolean(ctx.fileTunnel),
        };
      },
    });

    // ── Connectivity probe ────────────────────────────────────────────────
    ctx.registerRoute({
      method: 'POST',
      url: '/provider/test',
      preHandler: requireServerRead('server.read'),
      handler: async (request, reply) => {
        try {
          const pcfg = providerConfig(ctx);
          if (!pcfg.apiKey) return fail(reply, 'apiKey is not configured — set it in the plugin settings first');
          const started = Date.now();
          const probe = await pingProvider(pcfg);
          return { success: true, ok: true, provider: pcfg.provider, model: pcfg.model, latencyMs: Date.now() - started, sample: probe.sample };
        } catch (err) {
          ctx.logger.warn({ err: err.message }, 'AI provider test failed');
          return reply.status(502).send({ success: false, error: `provider test failed: ${err.message}` });
        }
      },
    });

    // ── Servers ───────────────────────────────────────────────────────────
    ctx.registerRoute({
      method: 'GET',
      url: '/servers',
      preHandler: requireServerRead('server.read'),
      handler: async () => {
        const servers = await ctx.db.servers.findMany({
          select: {
            id: true, uuid: true, name: true, status: true, nodeId: true,
            templateId: true, primaryIp: true, primaryPort: true,
            allocatedMemoryMb: true, allocatedCpuCores: true, allocatedDiskMb: true,
          },
          take: 200,
          orderBy: { name: 'asc' },
        });
        return { success: true, servers };
      },
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/servers/:id',
      preHandler: requireServerRead('server.read'),
      handler: async (request, reply) => {
        try {
          const s = await resolveServer(ctx, request.params.id);
          return { success: true, server: { ...s, environment: maskEnv(s.environment || {}) } };
        } catch (err) {
          return fail(reply, err.message, 404);
        }
      },
    });

    // ── File inspection (explicit user-permission gates on top of auth) ───
    const canReadFiles = (request) => ctx.hasPermission?.(request, 'file.read', 'server.read') ?? true;
    const canWriteFiles = (request) => ctx.hasPermission?.(request, 'file.write') ?? true;

    ctx.registerRoute({
      method: 'GET',
      url: '/servers-id/:id/files',
      preHandler: requireServerRead('server.read'),
      handler: async (request, reply) => {
        if (!cfg(ctx, 'allowFileReads')) return fail(reply, 'file reads are disabled in the plugin settings', 403);
        if (!canReadFiles(request)) return fail(reply, 'file.read permission required', 403);
        try {
          const s = await resolveServer(ctx, request.params.id);
          if (!ctx.fileTunnel) return fail(reply, 'fileTunnel not available (node offline or host disabled it)', 503);
          const dir = String(request.query?.path || '/');
          const res = await ctx.fileTunnel.queueRequest(s.nodeId, 'list', s.uuid, dir);
          if (!res.success) return fail(reply, res.error || 'list failed');
          const { listEntries } = await import('./tools.js');
          return { success: true, path: dir, entries: listEntries(res.data).slice(0, 200) };
        } catch (err) {
          return fail(reply, err.message);
        }
      },
    });

    // ── Conversations ─────────────────────────────────────────────────────
    const conversations = () => ctx.collection('conversations');
    const messages = () => ctx.collection('messages');
    const userIdOf = (request) => ctx.getUserId?.(request) ?? request?.user?.userId ?? request?.user?.id ?? 'unknown';

    ctx.registerRoute({
      method: 'GET',
      url: '/conversations',
      preHandler: requireServerRead('server.read'),
      handler: async (request) => {
        const serverId = request.query?.serverId ? String(request.query.serverId) : null;
        const filter = serverId ? { serverId } : {};
        const list = await conversations().find(filter, { sort: { updatedAt: -1 }, limit: 50 });
        return { success: true, conversations: list };
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/conversations',
      preHandler: requireServerRead('server.read'),
      handler: async (request) => {
        const body = request.body ?? {};
        const doc = await conversations().insert({
          id: newId('conv'),
          serverId: body.serverId ? String(body.serverId) : null,
          userId: userIdOf(request),
          title: String(body.title || 'New conversation').slice(0, 120),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        return { success: true, conversation: doc };
      },
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/conversations/:id',
      preHandler: requireServerRead('server.read'),
      handler: async (request, reply) => {
        const conv = await conversations().findOne({ id: request.params.id });
        if (!conv) return fail(reply, 'conversation not found', 404);
        const msgs = await messages().find({ conversationId: conv.id }, { sort: { createdAt: 1 }, limit: 200 });
        return { success: true, conversation: conv, messages: msgs };
      },
    });

    ctx.registerRoute({
      method: 'DELETE',
      url: '/conversations/:id',
      preHandler: requireServerRead('server.read'),
      handler: async (request, reply) => {
        const conv = await conversations().findOne({ id: request.params.id });
        if (!conv) return fail(reply, 'conversation not found', 404);
        await messages().delete({ conversationId: conv.id });
        await conversations().delete({ id: conv.id });
        return { success: true };
      },
    });

    // ── Chat (the agentic loop) ───────────────────────────────────────────
    ctx.registerRoute({
      method: 'POST',
      url: '/conversations/:id/chat',
      preHandler: requireServerRead('server.read'),
      handler: async (request, reply) => {
        const body = request.body ?? {};
        const text = String(body.message || '').trim();
        if (!text) return fail(reply, 'message is required');
        if (text.length > 20000) return fail(reply, 'message too long (max 20000 chars)');

        const conv = await conversations().findOne({ id: request.params.id });
        if (!conv) return fail(reply, 'conversation not found', 404);

        const pcfg = providerConfig(ctx);
        if (!pcfg.apiKey) return fail(reply, 'AI provider is not configured — set baseUrl, apiKey and model in Admin → Plugins → AI Assistant → Settings', 409);

        const serverId = body.serverId ? String(body.serverId) : (conv.serverId || null);
        const pastedLogs = body.pastedLogs ? String(body.pastedLogs).slice(0, MAX_PASTED_CHARS + 5000) : '';

        // File tools respect both the plugin settings and the caller's rights.
        const readsAllowed = Boolean(cfg(ctx, 'allowFileReads')) && canReadFiles(request);
        const writesAllowed = Boolean(cfg(ctx, 'allowFileWrites')) && canWriteFiles(request);
        if (body.serverId && !serverId) return fail(reply, 'serverId is required');

        const historyDocs = await messages().find({ conversationId: conv.id }, { sort: { createdAt: 1 }, limit: MAX_HISTORY_MESSAGES });
        const history = historyDocs
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role, content: String(m.content || '') }));
        history.push({ role: 'user', content: text });

        const serverBlock = serverId ? await serverContextBlock(ctx, serverId) : '';
        const { system, preamble, history: fitted, truncated } = buildPrompt(ctx, { history, serverBlock, pastedLogs });
        const llmMessages = [...preamble, ...fitted];

        const tools = toolDefinitions({ allowReads: readsAllowed, allowWrites: writesAllowed });
        const executor = createToolExecutor(ctx, { maxFileReadKb: Number(cfg(ctx, 'maxFileReadKb')) || DEFAULTS.maxFileReadKb });

        const started = Date.now();
        try {
          const { text: answer, trace } = await runChat(ctx, executor, tools, system, llmMessages);
          const now = new Date().toISOString();
          await messages().insert({ conversationId: conv.id, role: 'user', content: text.slice(0, 20000), createdAt: now });
          if (pastedLogs) {
            await messages().insert({
              conversationId: conv.id, role: 'user',
              content: `(attached logs, ${pastedLogs.length} chars — see analysis in the following reply)`,
              createdAt: now,
            });
          }
          await messages().insert({ conversationId: conv.id, role: 'assistant', content: answer, toolTrace: trace, createdAt: now });
          await conversations().update(
            { id: conv.id },
            {
              $set: {
                updatedAt: now,
                serverId: serverId || conv.serverId || null,
                title: conv.title === 'New conversation' && text ? text.slice(0, 80) : conv.title,
              },
            },
          );
          ctx.logger.info({ conv: conv.id, tools: trace.length, ms: Date.now() - started, truncated }, 'AI chat turn complete');
          return { success: true, reply: answer, toolTrace: trace, truncatedHistory: truncated, latencyMs: Date.now() - started };
        } catch (err) {
          ctx.logger.warn({ err: err.message }, 'AI chat turn failed');
          return reply.status(502).send({ success: false, error: `AI provider error: ${err.message}` });
        }
      },
    });
  },

  async onEnable(ctx) {
    ctx.logger.info('AI Assistant enabled');
  },

  async onDisable() {},
};

export default plugin;
