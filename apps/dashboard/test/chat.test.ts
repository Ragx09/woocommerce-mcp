// TC-UI-16-U1: chat conversation store and display helpers (no DOM needed).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, toApiError, type ChatReply } from '../src/api.js';
import { buildHistory, chatStore, describeToolError, formatArgs, formatResult, MAX_CONTENT, MAX_MESSAGES, replyLines, retryWait, toolLabel, type Turn } from '../src/chat.js';

const reply = (over: Partial<ChatReply> = {}): ChatReply => ({
  reply: 'There are 2 orders today.',
  toolCalls: [{ name: 'woo__list_orders', server: 'woo', args: { after: '2026-10-16' }, ok: true, ms: 120, resultPreview: '[]' }],
  stopped: 'answer',
  ...over,
});

beforeEach(() => chatStore.reset('u1'));

describe('buildHistory', () => {
  it('sends earlier turns as text only, then the question', () => {
    const turns: Turn[] = [
      { id: 1, role: 'user', content: 'hi' },
      { id: 2, role: 'assistant', content: 'hello', toolCalls: reply().toolCalls },
    ];
    expect(buildHistory(turns, 'orders?')).toEqual([
      { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'orders?' },
    ]);
  });
  it('stays within the server limits (40 messages, 8000 chars, last = user)', () => {
    const turns: Turn[] = Array.from({ length: 60 }, (_, i) => ({ id: i, role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(9000) }));
    const h = buildHistory(turns, 'q');
    expect(h).toHaveLength(MAX_MESSAGES);
    expect(h.at(-1)).toEqual({ role: 'user', content: 'q' });
    expect(Math.max(...h.map((m) => m.content.length))).toBe(MAX_CONTENT);
  });
});

describe('display helpers', () => {
  it('toolLabel strips the server prefix, keeps agent tools', () => {
    expect(toolLabel({ name: 'woo__list_orders', server: 'woo' })).toBe('list_orders');
    expect(toolLabel({ name: 'find_tools', server: null })).toBe('find_tools');
    expect(toolLabel({ name: 'made_up', server: 'woo' })).toBe('made_up');
  });
  it('formatArgs / formatResult', () => {
    expect(formatArgs({})).toBe('');
    expect(formatArgs(undefined)).toBe('');
    expect(formatArgs({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(formatResult('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(formatResult('{"a":1, "b": "cut off')).toBe('{"a":1, "b": "cut off'); // 500-char excerpt
    expect(formatResult('plain text')).toBe('plain text');
  });
});

describe('chatStore.send', () => {
  it('adds the question, then the answer with its tool calls', async () => {
    const post = vi.fn().mockResolvedValue(reply());
    await chatStore.send('  orders today?  ', post);
    expect(post).toHaveBeenCalledWith({ messages: [{ role: 'user', content: 'orders today?' }] });
    const s = chatStore.get();
    expect(s.pendingSince).toBeNull();
    expect(s.turns.map((t) => [t.role, t.content])).toEqual([['user', 'orders today?'], ['assistant', 'There are 2 orders today.']]);
    expect(s.turns[1]!.toolCalls).toHaveLength(1);
    await chatStore.send('and yesterday?', post);
    expect(post.mock.calls[1]![0].messages).toHaveLength(3);
  });
  it('one request at a time; empty questions are ignored', async () => {
    let resolve!: (r: ChatReply) => void;
    const post = vi.fn().mockReturnValue(new Promise<ChatReply>((r) => { resolve = r; }));
    const first = chatStore.send('one', post);
    expect(chatStore.get().pendingSince).not.toBeNull();
    await chatStore.send('two', post);
    await chatStore.send('   ', post);
    expect(post).toHaveBeenCalledTimes(1);
    resolve(reply());
    await first;
    expect(chatStore.get().turns).toHaveLength(2);
  });
  it('on error the question goes back to the input and the error is shown', async () => {
    const post = vi.fn().mockRejectedValue(toApiError(429, { error: 'llm_rate_limited' }, '23'));
    await chatStore.send('orders?', post);
    const s = chatStore.get();
    expect(s.turns).toEqual([]);
    expect(s.draft).toBe('orders?');
    expect(s.error).toMatchObject({ message: "The AI provider's rate limit was reached. Try again in 23 s.", code: "llm_rate_limited", retryAfterSec: 23 });
    // the next send clears the error once the wait is over: see 'rate-limit wait' (TC-UI-18-U1)
  });
  it('an answer that arrives after "New chat" / sign-out is dropped', async () => {
    let resolve!: (r: ChatReply) => void;
    const p = chatStore.send('q', () => new Promise<ChatReply>((r) => { resolve = r; }));
    chatStore.reset(null);
    resolve(reply());
    await p;
    expect(chatStore.get().turns).toEqual([]);
    expect(chatStore.get().pendingSince).toBeNull();
  });
  it('keeps the unreachable servers of an answer (UI-18)', async () => {
    await chatStore.send('orders?', vi.fn().mockResolvedValue(reply({ toolCalls: [], unavailable: [{ server: 'woo', name: 'Woo' }] })));
    expect(chatStore.get().turns[1]!.unavailable).toEqual([{ server: 'woo', name: 'Woo' }]);
  });
  it('another user starts with an empty conversation', async () => {
    await chatStore.send('mine', vi.fn().mockResolvedValue(reply()));
    chatStore.bind('u1');
    expect(chatStore.get().turns).toHaveLength(2);
    chatStore.bind('u2');
    expect(chatStore.get().turns).toEqual([]);
  });
});

describe('chat error messages', () => {
  it('chat codes get a message a user can act on; 5xx text is never shown', () => {
    expect(toApiError(503, { error: 'chat_disabled', message: 'x' }, null).message).toMatch(/not set up/);
    expect(toApiError(429, { error: 'chat_busy' }, null).message).toMatch(/still being answered/);
    expect(toApiError(504, { error: 'llm_timeout', message: 'internal detail' }, null).message).not.toContain('internal detail');
    expect(toApiError(429, { error: 'llm_rate_limited' }, null).message).toMatch(/in a minute/);
    expect(toApiError(502, { error: 'chat_failed' }, null)).toBeInstanceOf(ApiError);
  });
});

describe('replyLines (Markdown subset as text)', () => {
  it('bold, code, headings and bullets', () => {
    expect(replyLines("**Today's orders**\n- **Count:** 0\n## Next\nuse `list_orders`")).toEqual([
      [{ text: "Today's orders", style: 'bold' }],
      [{ text: '• ' }, { text: 'Count:', style: 'bold' }, { text: ' 0' }],
      [{ text: 'Next', style: 'bold' }],
      [{ text: 'use ' }, { text: 'list_orders', style: 'code' }],
    ]);
  });
  it('HTML in a reply stays text; unmatched markers are kept', () => {
    expect(replyLines('<img src=x onerror=alert(1)> **x')).toEqual([[{ text: '<img src=x onerror=alert(1)> **x' }]]);
  });
});

// TC-UI-18-U1: failed tool calls and rate limits become messages a user can act on.
describe('describeToolError', () => {
  const d = (resultPreview: string, server: string | null = 'woo') => describeToolError({ server, resultPreview });
  it('maps the gateway failure texts', () => {
    expect(d('upstream_unreachable: upstream woo unreachable: connect ECONNREFUSED')).toMatchObject({ kind: 'unreachable', message: expect.stringMatching(/^The woo server could not be reached/) });
    expect(d('upstream_timeout: upstream woo did not answer within 15 s')).toMatchObject({ kind: 'timeout', message: expect.stringContaining('(15 s)') });
    expect(d('MCP error -32602: upstream github is disabled', 'github')).toMatchObject({ kind: 'disabled', message: expect.stringMatching(/^The github server is turned off/) });
    expect(d('unknown tool woo__made_up')).toMatchObject({ kind: 'unknown_tool' });
    expect(d('upstream_error: upstream woo failed: bad gateway')).toMatchObject({ kind: 'upstream_error' });
  });
  it("a tool's own error stays a tool error, even when it mentions a timeout", () => {
    expect(d('{"code":"woocommerce_rest_invalid_id","message":"Invalid ID."}').kind).toBe('tool_error');
    expect(d('payment provider timeout, upstream_timeout: not ours').kind).toBe('tool_error');
    expect(d('the arguments were not a JSON object', null).kind).toBe('tool_error');
  });
  it('never echoes the raw text in the friendly message', () => {
    expect(d('upstream_unreachable: upstream woo unreachable: http://10.43.0.5:3000 refused').message).not.toContain('10.43');
  });
});

describe('rate-limit wait', () => {
  it('counts down from the arrival time and blocks sending until it is over', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      await chatStore.send('orders?', vi.fn().mockRejectedValue(toApiError(429, { error: 'llm_rate_limited' }, '20')));
      const err = chatStore.get().error!;
      expect(err).toMatchObject({ code: 'llm_rate_limited', retryAfterSec: 20, at: 1_000_000 });
      expect(retryWait(err, 1_000_000)).toBe(20);
      expect(retryWait(err, 1_012_500)).toBe(8);
      const post = vi.fn().mockResolvedValue(reply());
      await chatStore.send('orders?', post);
      expect(post).not.toHaveBeenCalled();
      vi.setSystemTime(1_020_000);
      expect(retryWait(err, Date.now())).toBe(0);
      await chatStore.send('orders?', post);
      expect(post).toHaveBeenCalledTimes(1);
      expect(chatStore.get().error).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it('errors without Retry-After do not block', () => {
    expect(retryWait({ message: 'x', code: 'llm_timeout' }, Date.now())).toBe(0);
    expect(retryWait(null, Date.now())).toBe(0);
  });
});
