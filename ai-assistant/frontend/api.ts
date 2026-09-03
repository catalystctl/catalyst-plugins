/**
 * AI Assistant — typed API client via the host plugin SDK.
 */

import { createPluginApi } from '@catalyst/plugin-sdk/frontend';

const api = createPluginApi('ai-assistant');

export interface ProviderStatus {
  provider: string;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  keySuffix: string | null;
  contextWindowTokens: number;
  maxOutputTokens: number;
  temperature: number;
  allowFileReads: boolean;
  allowFileWrites: boolean;
  maxFileReadKb: number;
  fileTunnelAvailable: boolean;
}

export interface ServerSummary {
  id: string;
  uuid: string;
  name: string;
  status: string;
  nodeId: string;
  templateId: string;
}

export interface Conversation {
  id: string;
  serverId: string | null;
  title: string;
  updatedAt: string;
  createdAt: string;
  _id?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  toolTrace?: Array<{ tool: string; args: unknown; resultChars: number; truncated: boolean }>;
  createdAt: string;
  _id?: string;
}

export interface ToolTraceItem {
  tool: string;
  args: unknown;
  resultChars: number;
  truncated: boolean;
}

export async function fetchStatus(): Promise<ProviderStatus> {
  const res = await api.get<any>('/status');
  if (!res.success) throw new Error(res.error || 'Failed to load provider status');
  return res as unknown as ProviderStatus;
}

export async function testProvider(): Promise<{ latencyMs: number; model: string; sample: string }> {
  const res = await api.post<any>('/provider/test', {});
  if (!res.success) throw new Error(res.error || 'Provider test failed');
  return res as unknown as { latencyMs: number; model: string; sample: string };
}

export async function fetchServers(): Promise<ServerSummary[]> {
  const res = await api.get<any>('/servers');
  if (!res.success) throw new Error(res.error || 'Failed to list servers');
  return ((res as any).servers ?? []) as ServerSummary[];
}

export async function fetchConversations(serverId?: string | null): Promise<Conversation[]> {
  const q = serverId ? `?serverId=${encodeURIComponent(serverId)}` : '';
  const res = await api.get<any>(`/conversations${q}`);
  if (!res.success) throw new Error(res.error || 'Failed to list conversations');
  return ((res as any).conversations ?? []) as Conversation[];
}

export async function createConversation(opts?: { serverId?: string | null; title?: string }): Promise<Conversation> {
  const res = await api.post<any>('/conversations', {
    serverId: opts?.serverId ?? null,
    title: opts?.title ?? 'New conversation',
  });
  if (!res.success) throw new Error(res.error || 'Failed to create conversation');
  return (res as any).conversation as Conversation;
}

export async function fetchConversation(id: string): Promise<{ conversation: Conversation; messages: ChatMessage[] }> {
  const res = await api.get<any>(`/conversations/${id}`);
  if (!res.success) throw new Error(res.error || 'Failed to load conversation');
  return res as unknown as { conversation: Conversation; messages: ChatMessage[] };
}

export async function deleteConversation(id: string): Promise<void> {
  const res = await api.del<any>(`/conversations/${id}`);
  if (!res.success) throw new Error(res.error || 'Failed to delete conversation');
}

export async function sendChat(
  id: string,
  payload: { message: string; serverId?: string | null; pastedLogs?: string },
): Promise<{ reply: string; toolTrace: ToolTraceItem[]; latencyMs: number }> {
  const res = await api.post<any>(`/conversations/${id}/chat`, payload);
  if (!res.success) throw new Error(res.error || 'Chat failed');
  return res as unknown as { reply: string; toolTrace: ToolTraceItem[]; latencyMs: number };
}
