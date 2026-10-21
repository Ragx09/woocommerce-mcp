// UI-02: the one way the dashboard talks to the gateway. Same-origin only (the session cookie is
// HttpOnly + SameSite=Strict, so the browser attaches it; this code never sees it), JSON in and out,
// and every failure becomes an ApiError with a stable `code` and a message fit to show a user.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  signal?: AbortSignal;
}

/** Messages for codes the user can act on; anything else uses the server's message or a generic one. */
const FRIENDLY: Record<string, string> = {
  network_error: 'Cannot reach the server. Check your connection and try again.',
  unauthenticated: 'Your session has ended. Please sign in again.',
  invalid_credentials: 'Wrong email or password.',
  forbidden: 'You do not have permission to do that.',
  not_found: 'Not found.',
  invite_used: 'This invite has already been used.',
  invite_expired: 'This invite has expired. Ask an admin for a new one.',
  internal: 'Something went wrong on the server. Please try again.',
  chat_disabled: 'The chat is not set up on this server (no LLM key configured). Ask an admin.',
  chat_busy: 'Your previous message is still being answered. Wait for it to finish.',
  llm_timeout: 'The AI provider took too long to answer. Try again.',
  llm_unavailable: 'The AI provider cannot be reached right now. Try again in a moment.',
  llm_error: 'The AI provider returned an error. Try again or rephrase the question.',
  chat_failed: 'The chat agent could not reach the tools. Try again.',
};

let onUnauthenticated: () => void = () => {};
/** Called when a request finds the session gone (401 `unauthenticated`); the app sends the user to /login. */
export function setUnauthenticatedHandler(fn: () => void): void {
  onUnauthenticated = fn;
}

export function toApiError(status: number, body: unknown, retryAfter: string | null): ApiError {
  const b = (typeof body === 'object' && body !== null ? body : {}) as { error?: unknown; message?: unknown };
  const code = typeof b.error === 'string' ? b.error : status >= 500 ? 'internal' : `http_${status}`;
  const serverMsg = typeof b.message === 'string' && status < 500 ? b.message : undefined;
  let message = FRIENDLY[code] ?? serverMsg ?? (status >= 500 ? FRIENDLY.internal! : `Request failed (${status}).`);
  let retryAfterSec: number | undefined;
  if (code === 'rate_limited') {
    const s = Number(retryAfter);
    retryAfterSec = Number.isFinite(s) && s > 0 ? s : undefined;
    const mins = retryAfterSec ? Math.ceil(retryAfterSec / 60) : undefined;
    message = `Too many attempts. Try again ${mins ? `in ${mins} minute${mins === 1 ? '' : 's'}` : 'later'}.`;
  } else if (code === 'llm_rate_limited') {
    // The provider's per-minute token budget (Groq free tier: about two questions a minute).
    const s = Number(retryAfter);
    retryAfterSec = Number.isFinite(s) && s > 0 ? Math.ceil(s) : undefined;
    message = `The AI provider's rate limit was reached. Try again ${retryAfterSec ? `in ${retryAfterSec} s` : 'in a minute'}.`;
  }
  return new ApiError(status, code, message, retryAfterSec);
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? 'GET',
      credentials: 'same-origin',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'network_error', FRIENDLY.network_error!);
  }
  if (res.status === 204) return undefined as T;
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  const body: unknown = isJson ? await res.json().catch(() => undefined) : undefined;
  if (res.ok) return body as T;
  const err = toApiError(res.status, body, res.headers.get('retry-after'));
  if (err.code === 'unauthenticated') onUnauthenticated();
  throw err;
}

// Response shapes (docs/API_CONTRACTS.md).
export type Role = 'admin' | 'member';
export interface Me {
  id: string;
  email: string;
  name: string;
  role: Role;
}
export interface InviteInfo {
  email: string;
  role: Role;
  expiresAt: string;
}

export type UpstreamStatus = 'unknown' | 'connected' | 'unreachable' | 'disabled';
export interface Upstream {
  id: string;
  name: string;
  slug: string;
  enabled: boolean;
  status: UpstreamStatus;
  lastError: string | null;
  lastCheckedAt: string | null;
  lastOkAt: string | null;
  toolCount: number | null;
  // Admin only:
  url?: string;
  authType?: 'none' | 'bearer' | 'header';
  authHeader?: string | null;
  hasCredential?: boolean;
}
export interface ToolInfo {
  publicName: string;
  name: string;
  title: string | null;
  description: string;
  params: { name: string; required: boolean }[];
}

export interface Member {
  id: string;
  email: string;
  name: string;
  role: Role;
  disabledAt: string | null;
  createdAt: string;
  activeKeys: number;
  lastKeyUseAt: string | null;
}
export interface OpenInvite {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
}
export interface CreatedInvite extends OpenInvite {
  inviteUrl: string;
}
export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  owner: { id: string; email: string; name: string };
}
export interface CreatedKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  /** Plaintext, in this one response only. */
  key: string;
}

export type AuditOutcome = 'ok' | 'tool_error' | 'error' | 'timeout' | 'unreachable' | 'rejected' | 'denied';
export interface AuditItem {
  id: string;
  ts: string;
  requestId: string | null;
  source: 'mcp' | 'chat';
  method: string;
  upstream: string | null;
  tool: string | null;
  durationMs: number;
  outcome: AuditOutcome;
  errorCode: string | null;
  keyPrefix: string | null;
  user: { id: string; email: string; name: string } | null;
}
export interface AuditPage {
  items: AuditItem[];
  nextCursor: string | null;
}

// UI-16 chat (POST /api/chat).
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}
export interface ToolCall {
  /** Public gateway name, e.g. `woo__list_orders`. */
  name: string;
  /** Upstream slug; null for the agent's own `find_tools`. */
  server: string | null;
  args: unknown;
  ok: boolean;
  ms: number;
  /** First 500 characters of the result or error. */
  resultPreview: string;
}
export type ChatStop = 'answer' | 'max_steps' | 'deadline';
export interface ChatReply {
  reply: string;
  toolCalls: ToolCall[];
  stopped: ChatStop;
  /** UI-18: enabled servers that could not be reached when the question was asked (their tools were missing). */
  unavailable?: { server: string; name: string }[];
}
