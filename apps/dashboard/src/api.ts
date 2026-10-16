import type { AuditEntry, AuthType, ChatEvent, Key, Role, Server, Session, User } from './types.ts';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export const login = (email: string, password: string) =>
  post<Session>('/login', { email, password });
export const logout = () => post<void>('/logout');
export const me = () => api<Session>('/me');
export const acceptInvite = (token: string, password: string) =>
  post<Session>('/invite/accept', { token, password });

export const listServers = () => api<{ servers: Server[] }>('/servers');
export type ServerInput = {
  slug: string;
  name: string;
  url: string;
  authType: AuthType;
  authHeader?: string;
  credential?: string;
};
export const createServer = (input: ServerInput) => post<{ server: Server }>('/servers', input);
export const updateServer = (id: string, patch: Partial<Omit<ServerInput, 'slug'>> & { enabled?: boolean }) =>
  api<{ server: Server }>(`/servers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
export const deleteServer = (id: string) => api<void>(`/servers/${id}`, { method: 'DELETE' });
export const setToolAccess = (tool: string, memberAllowed: boolean) =>
  api<void>('/tool-access', { method: 'PUT', body: JSON.stringify({ tool, memberAllowed }) });

export const listUsers = () => api<{ users: (User & { keys: Key[] })[] }>('/users');
export const createUser = (email: string, role: Role) =>
  post<{ user: User; inviteToken: string }>('/users', { email, role });
export const reinvite = (id: string) => post<{ inviteToken: string }>(`/users/${id}/invite`);
export const deleteUser = (id: string) => api<void>(`/users/${id}`, { method: 'DELETE' });

export const listKeys = () => api<{ keys: Key[] }>('/keys');
export const createKey = (name: string, userId?: string) =>
  post<{ key: Key; secret: string }>('/keys', userId ? { name, userId } : { name });
export const revokeKey = (id: string) => api<void>(`/keys/${id}`, { method: 'DELETE' });

export const listAudit = (limit = 100) => api<{ entries: AuditEntry[] }>(`/audit?limit=${limit}`);

/** Streams one ChatEvent per ndjson line. */
export async function* chat(
  messages: { role: 'user' | 'assistant'; content: string }[],
  signal: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) yield JSON.parse(line) as ChatEvent;
  }
  if (buffer.trim()) yield JSON.parse(buffer) as ChatEvent;
}
