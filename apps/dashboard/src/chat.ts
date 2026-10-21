// UI-16: the chat conversation, kept outside the page component so it survives moving to another page
// (e.g. to check the audit log) while an answer is still on its way. It lives in memory only: nothing
// is written to browser storage, a reload starts a new chat, and signing out (or another user signing
// in) clears it. The server keeps no conversation either; every request carries the history.
import { useSyncExternalStore } from 'react';
import { ApiError, api, type ChatMessage, type ChatReply, type ChatStop, type ToolCall } from './api.js';

export interface Turn {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  stopped?: ChatStop;
  unavailable?: { server: string; name: string }[];
}
export interface ChatState {
  userId: string | null;
  turns: Turn[];
  /** Start time (ms) of the request in flight, or null. */
  pendingSince: number | null;
  /** `at` = when the error arrived (ms), so the page can count down `retryAfterSec`. */
  error: { message: string; code?: string; retryAfterSec?: number; at?: number } | null;
  draft: string;
}

/** Server limits (POST /api/chat): 1..40 messages, each 1..8000 characters, the last from the user. */
export const MAX_MESSAGES = 40;
export const MAX_CONTENT = 8000;

/** The request body for a new question: earlier turns (assistant text only, no tool data) + the question. */
export function buildHistory(turns: Turn[], question: string): ChatMessage[] {
  const msgs: ChatMessage[] = turns
    .map((t) => ({ role: t.role, content: t.content.slice(0, MAX_CONTENT) }))
    .filter((m) => m.content.trim() !== '');
  msgs.push({ role: 'user', content: question.slice(0, MAX_CONTENT) });
  return msgs.slice(-MAX_MESSAGES);
}

/** `woo__list_orders` + `woo` → `list_orders`; the agent's own tools (no server) keep their name. */
export function toolLabel(call: Pick<ToolCall, 'name' | 'server'>): string {
  return call.server && call.name.startsWith(`${call.server}__`) ? call.name.slice(call.server.length + 2) : call.name;
}

/** Arguments as readable JSON; `{}` / absent → empty string. */
export function formatArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  if (typeof args === 'object' && Object.keys(args as object).length === 0) return '';
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

/** A JSON result excerpt is pretty-printed when it parses; a cut-off excerpt (500 chars) stays as is. */
export function formatResult(preview: string): string {
  const t = preview.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return preview;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return preview;
  }
}

// --- failed tool calls (UI-18) ---
// The gateway reports a failed call as text: `upstream_unreachable: …`, `upstream_timeout: …`,
// `upstream_error: …` (isError results), JSON-RPC errors such as `upstream woo is disabled` /
// `unknown tool: x`, or the tool's own error text. Each becomes a kind and one sentence a user can act on;
// the raw excerpt stays in the expanded card.
export type ToolErrorKind = 'unreachable' | 'timeout' | 'disabled' | 'unknown_tool' | 'upstream_error' | 'tool_error';
export interface ToolErrorInfo { kind: ToolErrorKind; message: string }

export function describeToolError(call: Pick<ToolCall, 'server' | 'resultPreview'>): ToolErrorInfo {
  const text = call.resultPreview;
  const who = call.server ? `The ${call.server} server` : 'The server';
  const secs = /within ([\d.]+) s/.exec(text)?.[1];
  // Only the gateway's own codes and phrasings count; a tool's error text that merely mentions
  // "timeout" stays a tool error.
  if (/^upstream_unreachable:/.test(text)) {
    return { kind: 'unreachable', message: `${who} could not be reached. It may be down or restarting; check the Servers page and try again in a moment.` };
  }
  if (/^upstream_timeout:/.test(text)) {
    return { kind: 'timeout', message: `${who} did not answer in time${secs ? ` (${secs} s)` : ''}. Try again, or ask for less data.` };
  }
  if (/\bupstream \S+ is disabled\b/.test(text)) {
    return { kind: 'disabled', message: `${who} is turned off by an admin, so its tools cannot be used.` };
  }
  if (/\bunknown tool\b/.test(text)) {
    return { kind: 'unknown_tool', message: 'The AI asked for a tool that does not exist. Rephrasing the question usually helps.' };
  }
  if (/^upstream_error:/.test(text)) {
    return { kind: 'upstream_error', message: `${who} failed while handling the call. Try again; if it keeps failing, check the Servers page.` };
  }
  return { kind: 'tool_error', message: 'The tool reported an error (for example invalid input). Details below.' };
}

/** Seconds left until a rate-limited chat may be retried; 0 when it can be sent now. */
export function retryWait(error: ChatState['error'], now: number): number {
  if (!error?.retryAfterSec || error.at === undefined) return 0;
  return Math.max(0, Math.ceil((error.at + error.retryAfterSec * 1000 - now) / 1000));
}

// --- store ---
const empty = (userId: string | null): ChatState => ({ userId, turns: [], pendingSince: null, error: null, draft: '' });
let state: ChatState = empty(null);
let nextId = 1;
/** Bumped on reset, so an answer to a conversation that was cleared meanwhile is dropped. */
let generation = 0;
const listeners = new Set<() => void>();

function set(patch: Partial<ChatState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const chatStore = {
  get: (): ChatState => state,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /** Start a new chat. */
  reset(userId: string | null = state.userId): void {
    generation++;
    state = empty(userId);
    for (const l of listeners) l();
  },
  /**
   * The conversation belongs to one user; anyone else starts empty. Called while rendering the page,
   * before it reads the state, so it changes the state without notifying anyone.
   */
  bind(userId: string): void {
    if (state.userId === userId) return;
    generation++;
    state = empty(userId);
  },
  setDraft(draft: string): void {
    set({ draft });
  },
  async send(question: string, post: (body: { messages: ChatMessage[] }) => Promise<ChatReply> = (body) =>
    api<ChatReply>('/api/chat', { method: 'POST', body })): Promise<void> {
    const q = question.trim();
    // A rate-limited request would only be refused again (UI-18): wait for the provider's reset.
    if (!q || state.pendingSince !== null || retryWait(state.error, Date.now()) > 0) return;
    const gen = generation;
    const messages = buildHistory(state.turns, q);
    const userTurn: Turn = { id: nextId++, role: 'user', content: q };
    set({ turns: [...state.turns, userTurn], pendingSince: Date.now(), error: null, draft: '' });
    try {
      const r = await post({ messages });
      if (gen !== generation) return;
      const answer: Turn = { id: nextId++, role: 'assistant', content: r.reply, toolCalls: r.toolCalls, stopped: r.stopped, unavailable: r.unavailable };
      set({ turns: [...state.turns, answer], pendingSince: null });
    } catch (e) {
      if (gen !== generation) return;
      // The question did not get an answer: take it out of the conversation and give it back to the
      // input box, so a retry sends it again with the same history.
      const err = e instanceof ApiError
        ? { message: e.message, code: e.code, ...(e.retryAfterSec ? { retryAfterSec: e.retryAfterSec, at: Date.now() } : {}) }
        : { message: 'The chat request failed. Try again.' };
      set({ turns: state.turns.filter((t) => t.id !== userTurn.id), pendingSince: null, error: err, draft: state.draft || q });
    }
  },
};

export function useChat(): ChatState {
  return useSyncExternalStore(chatStore.subscribe, chatStore.get);
}

// --- reply text ---
// Models answer in Markdown. Only a safe subset is drawn — **bold**, `code`, # headings, - bullets — and
// always as React text nodes, never as HTML: the reply can quote tool results (product names, order notes)
// written by anyone.
export interface Segment { text: string; style?: 'bold' | 'code' }

export function inlineSegments(line: string): Segment[] {
  const out: Segment[] = [];
  const re = /\*\*(.+?)\*\*|`([^`\n]+)`/g;
  let last = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > last) out.push({ text: line.slice(last, m.index) });
    out.push(m[1] !== undefined ? { text: m[1], style: 'bold' } : { text: m[2]!, style: 'code' });
    last = re.lastIndex;
  }
  if (last < line.length) out.push({ text: line.slice(last) });
  return out;
}

/** One entry per line: headings become bold lines, `-`/`*` bullets become "• ". */
export function replyLines(text: string): Segment[][] {
  return text.split('\n').map((line) => {
    const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (h) return [{ text: h[1]!.replace(/\*\*/g, ''), style: 'bold' }];
    return inlineSegments(line.replace(/^(\s*)[-*]\s+/, '$1• '));
  });
}
