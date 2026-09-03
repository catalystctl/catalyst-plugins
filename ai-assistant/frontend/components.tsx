/**
 * AI Assistant — chat UI (admin tab + server tab).
 *
 * Admin tab: pick any server (or none), manage conversations, test the
 * provider connection. Server tab: same chat pre-scoped to that server with
 * one-click diagnostic prompts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bot, CheckCircle2, Server as ServerIcon, Wrench } from 'lucide-react';
import {
  Button,
  Select,
  SelectItem,
  Textarea,
  Badge,
  Skeleton,
  Card,
  TEXT_MUTED,
  FONT_MONO,
  Loader2,
  Plus,
  Trash2,
  Copy,
  Send,
} from './ui';
import * as api from './api';
import type { ChatMessage, Conversation, ProviderStatus, ServerSummary } from './api';

const QUICK_PROMPTS = [
  {
    label: 'Review startup config',
    prompt:
      'Review this server\u2019s startup command and environment variables. Point out anything misconfigured or risky, and tell me exactly what to change.',
  },
  {
    label: 'Diagnose crash loop',
    prompt:
      'This server keeps crashing or fails to start. Read its config files and tell me the most likely causes in order, with the exact file lines or settings behind each one.',
  },
  {
    label: 'Which files to check?',
    prompt:
      'List the config and log files I should check first for this kind of server, then read the most important ones and summarize what you find.',
  },
];

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const [copied, setCopied] = useState(false);
  const mine = msg.role === 'user';
  const copy = () => {
    try {
      navigator.clipboard?.writeText(msg.content).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      });
    } catch { /* clipboard unavailable */ }
  };
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-lg border px-3 py-2 text-sm ${
          mine ? 'border-primary/30 bg-primary/10' : 'border-border bg-card'
        }`}
      >
        <div className="mb-1 flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
          {mine ? null : <Bot className="h-3 w-3" />}
          <span>{mine ? 'You' : 'Assistant'}</span>
          {msg.createdAt ? <span>· {timeAgo(msg.createdAt)}</span> : null}
          <button onClick={copy} className="ml-auto opacity-60 hover:opacity-100" aria-label="Copy message">
            <Copy className="h-3 w-3" />
          </button>
          {copied ? <span className="text-emerald-400">copied</span> : null}
        </div>
        <div className="whitespace-pre-wrap break-words">{msg.content}</div>
        {msg.toolTrace && msg.toolTrace.length > 0 && (
          <details className="mt-2 text-xs" style={{ color: 'var(--muted-foreground)' }}>
            <summary className="cursor-pointer">
              <Wrench className="mr-1 inline h-3 w-3" />
              Checked {msg.toolTrace.length} source{msg.toolTrace.length === 1 ? '' : 's'} ({msg.toolTrace.map((t) => t.tool).join(', ')})
            </summary>
          </details>
        )}
      </div>
    </div>
  );
}

function ProviderBadge({ status }: { status: ProviderStatus | null }) {
  if (!status) return <Badge>loading…</Badge>;
  if (!status.hasApiKey) return <Badge tone="warn">No API key — open plugin Settings</Badge>;
  return (
    <Badge tone="ok">
      <CheckCircle2 className="h-3 w-3" /> {status.model} · {status.provider}
    </Badge>
  );
}

function useAssistant(lockedServerId: string | null) {
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [servers, setServers] = useState<ServerSummary[] | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [serverId, setServerId] = useState<string>(lockedServerId ?? '');
  const [input, setInput] = useState('');
  const [pastedLogs, setPastedLogs] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (lockedServerId) setServerId(lockedServerId);
  }, [lockedServerId]);

  const refreshAll = useCallback(async () => {
    try {
      const [st, sv] = await Promise.all([api.fetchStatus(), api.fetchServers()]);
      setStatus(st);
      setServers(sv);
      const convs = await api.fetchConversations(lockedServerId ?? undefined);
      setConversations(convs);
      if (!activeId && convs.length > 0) setActiveId(convs[0].id);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load');
    }
  }, [lockedServerId, activeId]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  const loadConversation = useCallback(async (id: string) => {
    setActiveId(id);
    setLoadingMsgs(true);
    setError(null);
    try {
      const { conversation, messages: msgs } = await api.fetchConversation(id);
      setMessages(msgs);
      if (conversation.serverId) setServerId(conversation.serverId);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load conversation');
    } finally {
      setLoadingMsgs(false);
    }
  }, []);

  useEffect(() => {
    if (activeId) loadConversation(activeId);
  }, [activeId, loadConversation]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, sending]);

  const newConversation = async () => {
    try {
      const conv = await api.createConversation({ serverId: serverId || null });
      setConversations((prev) => [conv, ...prev]);
      setActiveId(conv.id);
      setMessages([]);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to create conversation');
    }
  };

  const removeConversation = async (id: string) => {
    try {
      await api.deleteConversation(id);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeId === id) {
        setActiveId(null);
        setMessages([]);
      }
    } catch (e: any) {
      setError(e?.message ?? 'Delete failed');
    }
  };

  const send = async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || sending) return;
    setError(null);
    let convId = activeId;
    if (!convId) {
      try {
        const conv = await api.createConversation({ serverId: serverId || null });
        convId = conv.id;
        setConversations((prev) => [conv, ...prev]);
        setActiveId(convId);
      } catch (e: any) {
        setError(e?.message ?? 'Failed to create conversation');
        return;
      }
    }
    const optimistic: ChatMessage = { role: 'user', content: text, createdAt: new Date().toISOString() };
    setMessages((prev) => [...prev, optimistic]);
    setInput('');
    const logs = pastedLogs;
    setPastedLogs('');
    setSending(true);
    try {
      const res = await api.sendChat(convId as string, {
        message: text,
        serverId: serverId || null,
        pastedLogs: logs || undefined,
      });
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: res.reply, toolTrace: res.toolTrace, createdAt: new Date().toISOString() },
      ]);
      const convs = await api.fetchConversations(lockedServerId ?? undefined);
      setConversations(convs);
    } catch (e: any) {
      setError(e?.message ?? 'Chat failed');
    } finally {
      setSending(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.testProvider();
      setTestResult(`OK · ${res.model} · ${res.latencyMs}ms`);
    } catch (e: any) {
      setTestResult(`Failed: ${e?.message ?? 'unknown error'}`);
    } finally {
      setTesting(false);
    }
  };

  return {
    status, servers, conversations, activeId, setActiveId, messages,
    serverId, setServerId, input, setInput, pastedLogs, setPastedLogs,
    sending, loadingMsgs, error, testing, testResult,
    bottomRef, refreshAll, loadConversation, newConversation, removeConversation, send, test,
  };
}

function AssistantShell({ lockedServerId }: { lockedServerId?: string | null }) {
  const locked = lockedServerId ?? null;
  const a = useAssistant(locked);
  const activeConv = a.conversations.find((c) => c.id === a.activeId) ?? null;
  const serverName = a.servers?.find((s) => s.id === a.serverId || s.uuid === a.serverId)?.name;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-2xl font-bold">
          <Bot className="h-6 w-6 text-violet-400" /> AI Assistant
        </h2>
        <ProviderBadge status={a.status} />
        {a.status && !a.status.fileTunnelAvailable && <Badge tone="warn">File tunnel unavailable</Badge>}
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={a.test} disabled={a.testing}>
            {a.testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Test connection
          </Button>
          <Button size="sm" variant="outline" onClick={a.newConversation}>
            <Plus className="h-3.5 w-3.5" /> New chat
          </Button>
        </div>
      </div>

      {a.testResult && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs" style={{ color: TEXT_MUTED }}>
          {a.testResult.startsWith('OK') ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <AlertTriangle className="h-4 w-4 text-amber-400" />}
          <span style={{ fontFamily: FONT_MONO }}>{a.testResult}</span>
        </div>
      )}

      {a.error && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-sm text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" /> {a.error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
        {/* Sidebar */}
        <div className="space-y-3">
          {!locked && (
            <Card>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: TEXT_MUTED }}>
                <ServerIcon className="mr-1 inline h-3.5 w-3.5" /> Server context
              </div>
              {a.servers === null ? (
                <Skeleton className="h-9 w-full" />
              ) : (
                <Select value={a.serverId} onValueChange={a.setServerId} placeholder="No server (general chat)">
                  {(a.servers ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name} · {s.status}
                    </SelectItem>
                  ))}
                </Select>
              )}
              {serverName && <div className="mt-1 text-xs" style={{ color: TEXT_MUTED }}>Chatting about {serverName}</div>}
            </Card>
          )}

          <Card>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: TEXT_MUTED }}>
              Conversations
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {a.conversations.length === 0 && (
                <div className="text-xs" style={{ color: TEXT_MUTED }}>No conversations yet.</div>
              )}
              {a.conversations.map((c) => (
                <div
                  key={c.id}
                  className={`group flex items-center gap-1 rounded-md px-2 py-1.5 text-xs ${c.id === a.activeId ? 'bg-accent' : 'hover:bg-accent/60'}`}
                >
                  <button className="min-w-0 flex-1 truncate text-left" onClick={() => a.setActiveId(c.id)} title={c.title}>
                    {c.title || 'Untitled'}
                  </button>
                  <button
                    className="shrink-0 opacity-0 group-hover:opacity-100"
                    onClick={() => a.removeConversation(c.id)}
                    aria-label="Delete conversation"
                  >
                    <Trash2 className="h-3 w-3 text-red-400" />
                  </button>
                </div>
              ))}
            </div>
          </Card>

          {locked && (
            <Card>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: TEXT_MUTED }}>
                Quick diagnostics
              </div>
              <div className="flex flex-col gap-1.5">
                {QUICK_PROMPTS.map((q) => (
                  <Button key={q.label} size="sm" variant="outline" onClick={() => a.send(q.prompt)}>
                    {q.label}
                  </Button>
                ))}
              </div>
            </Card>
          )}
        </div>

        {/* Chat */}
        <Card className="flex min-h-[480px] flex-col">
          {!a.activeId && a.messages.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm" style={{ color: TEXT_MUTED }}>
              <Bot className="h-8 w-8 opacity-50" />
              <div className="font-semibold text-foreground">Ask about a server, paste a crash log, or review a config.</div>
              <div className="max-w-md text-xs">
                The assistant can look up server settings and read server files itself. For console output, paste it
                below under “Attach logs” so it can cite the exact failing lines.
              </div>
              {!locked && (
                <div className="mt-2 flex flex-wrap justify-center gap-1.5">
                  {QUICK_PROMPTS.map((q) => (
                    <Button key={q.label} size="sm" variant="outline" onClick={() => a.send(q.prompt)}>
                      {q.label}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          ) : a.loadingMsgs ? (
            <div className="flex-1 space-y-2 p-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : (
            <div className="flex-1 space-y-3 overflow-y-auto p-1" style={{ maxHeight: 520 }}>
              {a.messages.map((m, i) => (
                <MessageBubble key={(m._id ?? i) + String(i)} msg={m} />
              ))}
              {a.sending && (
                <div className="flex items-center gap-2 text-xs" style={{ color: TEXT_MUTED }}>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking{activeConv ? '' : '…'} — reading servers/files as needed…
                </div>
              )}
              <div ref={a.bottomRef} />
            </div>
          )}

          <div className="mt-3 space-y-2 border-t border-border pt-3">
            <details>
              <summary className="cursor-pointer text-xs" style={{ color: TEXT_MUTED }}>
                Attach logs (paste console output for analysis)
              </summary>
              <Textarea
                className="mt-2"
                style={{ fontFamily: FONT_MONO }}
                placeholder="Paste server.log / console output here…"
                value={a.pastedLogs}
                onChange={(e) => a.setPastedLogs(e.target.value)}
                rows={5}
              />
              {a.pastedLogs && <div className="text-[11px]" style={{ color: TEXT_MUTED }}>{a.pastedLogs.length} chars attached</div>}
            </details>
            <div className="flex items-end gap-2">
              <Textarea
                placeholder={a.serverId ? `Ask about ${serverName ?? 'this server'}…` : 'Ask anything… (pick a server for grounded answers)'}
                value={a.input}
                onChange={(e) => a.setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    a.send();
                  }
                }}
                rows={2}
              />
              <Button onClick={() => a.send()} disabled={a.sending || !a.input.trim()}>
                {a.sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
            {a.status && !a.status.hasApiKey && (
              <div className="text-xs text-amber-300">
                No API key configured. Ask the panel owner to set one in Admin → Plugins → AI Assistant → Settings.
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

export function AiAdminTab() {
  return <AssistantShell lockedServerId={null} />;
}

export function AiServerTab({ serverId }: { serverId: string }) {
  return <AssistantShell lockedServerId={serverId} />;
}
