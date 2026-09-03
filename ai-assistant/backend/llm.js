/**
 * AI Assistant — LLM provider abstraction (zero dependencies, native fetch).
 *
 * Speaks three dialects, all configured by the panel owner:
 *   openai-completions  POST {baseUrl}/chat/completions  (OpenAI, OpenRouter, Ollama, vLLM, ...)
 *   openai-responses     POST {baseUrl}/responses         (OpenAI Responses API)
 *   anthropic-messages   POST {baseUrl}/messages          (Anthropic)
 *
 * Canonical message model used by the chat loop:
 *   { role: 'user', content: string }
 *   { role: 'assistant', content: string, toolCalls?: [{ id, name, args }] }
 *   { role: 'tool', toolCallId: string, name: string, content: string }
 */

export const PROVIDERS = ['openai-completions', 'openai-responses', 'anthropic-messages'];

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

function cleanBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

export function validateEndpointConfig(cfg) {
  if (!PROVIDERS.includes(cfg.provider)) {
    throw new Error(`unknown provider "${cfg.provider}" (expected one of ${PROVIDERS.join(', ')})`);
  }
  const base = cleanBaseUrl(cfg.baseUrl);
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`baseUrl is not a valid URL: "${cfg.baseUrl}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('baseUrl must start with http:// or https://');
  }
  if (!cfg.apiKey) throw new Error('apiKey is not configured (plugin settings)');
  if (!cfg.model) throw new Error('model is not configured (plugin settings)');
  return { ...cfg, baseUrl: base };
}

function buildSignal(timeoutMs) {
  try {
    if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(timeoutMs);
  } catch { /* fall through */ }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(new Error('LLM request timed out')), timeoutMs).unref?.();
  return ctrl.signal;
}

async function readError(res) {
  const text = await res.text().catch(() => '');
  if (!text) return `HTTP ${res.status}`;
  if (text.length > 2000) return `HTTP ${res.status}: ${text.slice(0, 2000)}…`;
  try {
    const body = JSON.parse(text);
    const msg = body?.error?.message || body?.error || body?.message || text;
    return `HTTP ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 1000)}`;
  } catch {
    return `HTTP ${res.status}: ${text}`;
  }
}

// ── OpenAI Chat Completions ────────────────────────────────────────────────

function toCompletionsMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content || '' });
    else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || '' };
      if (Array.isArray(m.toolCalls) && m.toolCalls.length) {
        msg.tool_calls = m.toolCalls.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) },
        }));
        if (!msg.content) msg.content = null;
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: String(m.content ?? '') });
    }
  }
  return out;
}

async function callCompletions(cfg, { system, messages, tools }, timeoutMs) {
  const body = {
    model: cfg.model,
    messages: toCompletionsMessages(system, messages),
    max_tokens: cfg.maxOutputTokens,
    temperature: cfg.temperature,
  };
  if (tools?.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = 'auto';
  }
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    signal: buildSignal(timeoutMs),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = await res.json();
  const msg = data?.choices?.[0]?.message;
  if (!msg) throw new Error('Completions endpoint returned no choices[0].message');
  const toolCalls = Array.isArray(msg.tool_calls)
    ? msg.tool_calls
        .filter((t) => t?.type === 'function' && t?.function?.name)
        .map((t) => {
          let args = {};
          try { args = JSON.parse(t.function.arguments || '{}'); } catch { args = { _raw: t.function.arguments }; }
          return { id: t.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: t.function.name, args };
        })
    : [];
  return { text: typeof msg.content === 'string' ? msg.content : '', toolCalls };
}

// ── Anthropic Messages ─────────────────────────────────────────────────────

function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content || '' });
    else if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const t of m.toolCalls || []) blocks.push({ type: 'tool_use', id: t.id, name: t.name, input: t.args ?? {} });
      out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
    } else if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: String(m.content ?? '') }],
      });
    }
  }
  // Anthropic requires the first message to be user; drop leading non-user turns.
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

async function callAnthropic(cfg, { system, messages, tools }, timeoutMs) {
  const body = {
    model: cfg.model,
    max_tokens: cfg.maxOutputTokens,
    system: system || undefined,
    messages: toAnthropicMessages(messages),
    temperature: cfg.temperature,
  };
  if (tools?.length) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  const res = await fetch(`${cfg.baseUrl}/messages`, {
    method: 'POST',
    signal: buildSignal(timeoutMs),
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = await res.json();
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const text = blocks.filter((b) => b?.type === 'text' && b.text).map((b) => b.text).join('');
  const toolCalls = blocks
    .filter((b) => b?.type === 'tool_use' && b.name)
    .map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} }));
  return { text, toolCalls };
}

// ── OpenAI Responses ───────────────────────────────────────────────────────

function toResponsesInput(messages) {
  const input = [];
  for (const m of messages) {
    if (m.role === 'user') input.push({ role: 'user', content: m.content || '' });
    else if (m.role === 'assistant') {
      if (m.content) input.push({ role: 'assistant', content: m.content });
      for (const t of m.toolCalls || []) {
        input.push({
          type: 'function_call',
          call_id: t.id,
          name: t.name,
          arguments: JSON.stringify(t.args ?? {}),
        });
      }
    } else if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.toolCallId, output: String(m.content ?? '') });
    }
  }
  return input;
}

async function callResponses(cfg, { system, messages, tools }, timeoutMs) {
  const body = {
    model: cfg.model,
    instructions: system || undefined,
    input: toResponsesInput(messages),
    max_output_tokens: cfg.maxOutputTokens,
    temperature: cfg.temperature,
  };
  if (tools?.length) {
    body.tools = tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
    body.tool_choice = 'auto';
  }
  const res = await fetch(`${cfg.baseUrl}/responses`, {
    method: 'POST',
    signal: buildSignal(timeoutMs),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = await res.json();
  const output = Array.isArray(data?.output) ? data.output : [];
  let text = '';
  const toolCalls = [];
  for (const item of output) {
    if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if ((part?.type === 'output_text' || part?.type === 'text') && part.text) text += part.text;
      }
    } else if (item?.type === 'function_call' && item.name) {
      let args = {};
      try { args = JSON.parse(item.arguments || '{}'); } catch { args = { _raw: item.arguments }; }
      toolCalls.push({ id: item.call_id || item.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: item.name, args });
    }
  }
  if (!text && typeof data?.output_text === 'string') text = data.output_text;
  return { text, toolCalls };
}

/**
 * Single provider round trip (no tool execution — the caller runs the loop).
 */
export async function callProvider(rawCfg, { system, messages, tools }, timeoutMs = 60000) {
  const cfg = validateEndpointConfig(rawCfg);
  if (cfg.provider === 'openai-completions') return callCompletions(cfg, { system, messages, tools }, timeoutMs);
  if (cfg.provider === 'anthropic-messages') return callAnthropic(cfg, { system, messages, tools }, timeoutMs);
  return callResponses(cfg, { system, messages, tools }, timeoutMs);
}

/** Minimal connectivity check used by the Test connection button. */
export async function pingProvider(rawCfg, timeoutMs = 30000) {
  const started = Date.now();
  const result = await callProvider(rawCfg, {
    system: 'You are a connectivity probe.',
    messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
    tools: [],
  }, timeoutMs);
  return { latencyMs: Date.now() - started, sample: (result.text || '').slice(0, 200) };
}
