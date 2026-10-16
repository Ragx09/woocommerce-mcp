// TC-UI-16-U1: chat conversation store and display helpers (no DOM needed).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, toApiError, type ChatReply } from '../src/api.js';
import { buildHistory, chatStore, formatArgs, formatResult, MAX_CONTENT, MAX_MESSAGES, replyLines, toolLabel, type Turn } from '../src/chat.js';

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
    expect(s.error).toEqual({ message: "The AI provider's rate limit was reached. Try again in 23 s.", retryAfterSec: 23 });
    // the next successful send clears the error
    await chatStore.send('orders?', vi.fn().mockResolvedValue(reply()));
    expect(chatStore.get().error).toBeNull();
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
