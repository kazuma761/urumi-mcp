export type Role = 'admin' | 'member';
export type AuthType = 'none' | 'bearer' | 'header';

export type User = {
  id: string;
  email: string;
  role: Role;
  pending: boolean;
  createdAt: string;
};

export type Key = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type ServerTool = { name: string; description: string; memberAllowed: boolean };

export type Server = {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  managed: boolean;
  status: 'connected' | 'unreachable' | 'disabled';
  tools: ServerTool[];
  error?: string | null;
  url?: string;
  authType?: AuthType;
  authHeader?: string | null;
  hasCredential?: boolean;
};

export type AuditEntry = {
  id: number;
  ts: string;
  userEmail: string;
  via: 'mcp' | 'chat';
  server: string | null;
  tool: string | null;
  durationMs: number;
  outcome: 'ok' | 'error' | 'timeout' | 'unreachable' | 'denied' | 'not_found' | 'rejected';
  error: string | null;
};

export type ChatEvent =
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; isError: boolean; text: string; durationMs: number }
  | { type: 'message'; text: string }
  | { type: 'error'; message: string };

export type Session = { user: User; chatEnabled: boolean };
