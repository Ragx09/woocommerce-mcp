// UI-14 unit tests: the OpenAI-compatible client (chat/llm.ts) and the agent loop (chat/agent.ts).
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { FIND_TOOLS, keywords, leaksSystemPrompt, PROMPT_LEAK_REPLY, RESULT_LIMIT, resultText, runAgent, selectTools, systemPrompt, toLlmTool, type McpSession } from '../../src/chat/agent.js';
import { LlmError, openAiCompatible, withFallback, type ChatCompletion, type ChatMessage, type Completion } from '../../src/chat/llm.js';
import type { LlmConfig } from '../../src/config.js';

const KEY = 'gsk_unit_test_key_0123456789abcdef';
const cfg: LlmConfig = { baseUrl: 'https://llm.example.test/v1', model: 'm', apiKey: KEY, timeoutMs: 1_000, maxTokens: 256 };

/** A fetch stub that records the request and answers with `res`. */
function stubFetch(res: () => Response | Promise<Response>) {
  const seen: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => { seen.push({ url, init }); return res(); }) as unknown as typeof fetch;
  return { f, seen };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as LlmError; } throw new Error('expected a rejection'); };

describe('TC-UI-13-U2 LLM fallback provider', () => {
  const ok = () => json(200, { choices: [{ message: { content: 'from fallback' }, finish_reason: 'stop' }] });
  const FB_KEY = 'sk-or-unit-fallback-key-0123456789';
  const fbCfg: LlmConfig = { ...cfg, baseUrl: 'https://fallback.example.test/v1', apiKey: FB_KEY };
  const req = { messages: [{ role: 'user' as const, content: 'hi' }], tools: [] };

  it('the same request goes to the fallback, with its own key and URL, when the primary is rate-limited, down, slow or too small', async () => {
    const failures: (() => Response)[] = [
      () => json(429, { error: { message: 'slow down' } }, { 'retry-after': '7' }),
      () => json(503, { error: { message: 'down' } }),
      () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); },
      () => json(413, { error: { code: 'rate_limit_exceeded' } }),
    ];
    for (const primaryRes of failures) {
      const p = stubFetch(primaryRes); const fb = stubFetch(ok); const seen: string[] = [];
      const out = await withFallback(openAiCompatible(cfg, p.f), openAiCompatible(fbCfg, fb.f), (c) => seen.push(c))(req);
      expect(out.content).toBe('from fallback');
      const sent = fb.seen[0]!;
      expect(sent.url).toBe('https://fallback.example.test/v1/chat/completions');
      expect((sent.init.headers as Record<string, string>).authorization).toBe(`Bearer ${FB_KEY}`);
      expect(JSON.parse(sent.init.body as string).messages).toEqual(req.messages);
      expect(seen).toHaveLength(1);
    }
  });

  it('a refused request (4xx other than 413/429) is not sent to the fallback; if the fallback fails too, the primary error is reported', async () => {
    const fb = stubFetch(ok);
    const e = await fail(withFallback(openAiCompatible(cfg, stubFetch(() => json(401, { error: { message: 'bad key' } })).f), openAiCompatible(fbCfg, fb.f))(req));
    expect(e.message).toMatch(/HTTP 401/);
    expect(fb.seen).toHaveLength(0);
    const both = await fail(withFallback(openAiCompatible(cfg, stubFetch(() => json(429, {}, { 'retry-after': '9' })).f),
      openAiCompatible(fbCfg, stubFetch(() => json(503, {})).f))(req));
    expect(both.code).toBe('llm_rate_limited');
    expect(both.retryAfterS).toBe(9);
  });

  it('without a fallback the primary is used as is', async () => {
    const p = stubFetch(ok);
    const primary = openAiCompatible(cfg, p.f);
    expect(withFallback(primary, null)).toBe(primary);
  });
});

describe('TC-UI-14-U1 LLM client', () => {
  it('sends model, messages, tools and the key only in the Authorization header; parses tool calls', async () => {
    const { f, seen } = stubFetch(() => json(200, { choices: [{ finish_reason: 'tool_calls', message: { content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'woo__list_orders', arguments: '{"date":"today"}' } }, { bogus: 1 }] } }] }));
    const tools = [toLlmTool({ name: 'woo__list_orders', inputSchema: { type: 'object' } })];
    const out = await openAiCompatible(cfg, f)({ messages: [{ role: 'user', content: 'hi' }], tools });
    expect(out).toEqual({ content: null, finishReason: 'tool_calls',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'woo__list_orders', arguments: '{"date":"today"}' } }] });
    expect(seen[0]!.url).toBe('https://llm.example.test/v1/chat/completions');
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.init.redirect).toBe('error');
    const sent = JSON.parse(String(seen[0]!.init.body));
    expect(sent).toMatchObject({ model: 'm', max_tokens: 256, tool_choice: 'auto', messages: [{ role: 'user', content: 'hi' }] });
    expect(String(seen[0]!.init.body)).not.toContain(KEY);
  });

  it('maps 429 (with Retry-After), 5xx, 4xx (safe provider code only), timeouts and network errors; never leaks the key or body text', async () => {
    const cases: [() => Response | Promise<Response>, string, RegExp][] = [
      [() => json(429, { error: { message: `slow down ${KEY}` } }, { 'retry-after': '7' }), 'llm_rate_limited', /try again in 7 s/],
      [() => json(503, { error: { message: 'down' } }), 'llm_unavailable', /HTTP 503/],
      [() => json(413, { error: { code: 'rate_limit_exceeded', message: `Request too large ${KEY}` } }), 'llm_error', /too large for the LLM provider's limits \(HTTP 413, rate_limit_exceeded\)/],
      [() => json(400, { error: { code: 'tool_use_failed', message: `echo: ${KEY} secret prompt` } }), 'llm_error', /HTTP 400, tool_use_failed/],
      [() => json(401, { error: { code: 'Invalid API Key: gsk_…', message: 'x' } }), 'llm_error', /^the LLM request was refused \(HTTP 401\)$/],
      [() => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }, 'llm_timeout', /within 1 s/],
      [() => { throw new TypeError(`fetch failed ${KEY}`); }, 'llm_unavailable', /could not be reached/],
      [() => new Response('not json', { status: 200 }), 'llm_error', /unreadable/],
      [() => json(200, { choices: [] }), 'llm_error', /no message/],
    ];
    for (const [res, code, msg] of cases) {
      const e = await fail(openAiCompatible(cfg, stubFetch(res).f)({ messages: [], tools: [] }));
      expect(e).toBeInstanceOf(LlmError);
      expect(e.code).toBe(code);
      expect(e.message).toMatch(msg);
      expect(e.message).not.toContain(KEY);
      expect(e.message).not.toContain('secret prompt');
    }
  });

  it('TC-UI-16-U2: Groq tool_use_failed is retried once with the reason for the model; other 4xx and a second failure are not', async () => {
    const ok = json(200, { choices: [{ message: { content: 'fine' }, finish_reason: 'stop' }] });
    const okBody = ok.clone();
    const why = 'parameters for tool woo__list_orders did not match schema: errors: [`/per_page`: maximum: got 100, want 50]';
    const bad = () => json(400, { error: { code: 'tool_use_failed', message: why, failed_generation: '…' } });
    const flaky = [bad(), ok];
    const a = stubFetch(() => flaky.shift()!);
    const user = { role: 'user' as const, content: 'orders today?' };
    expect((await openAiCompatible(cfg, a.f)({ messages: [user], tools: [] })).content).toBe('fine');
    expect(a.seen).toHaveLength(2);
    const retried = JSON.parse(String(a.seen[1]!.init.body)).messages;
    expect(retried[0]).toEqual(user);
    expect(retried[1].role).toBe('system');
    expect(retried[1].content).toContain('maximum: got 100, want 50');
    // a provider message echoing credentials is scrubbed before it reaches the prompt
    const echo = [json(400, { error: { code: 'tool_use_failed', message: `bad args; key ${KEY}; token ghp_${'a'.repeat(36)}` } }), okBody];
    const d = stubFetch(() => echo.shift()!);
    await openAiCompatible(cfg, d.f)({ messages: [user], tools: [] });
    const hint = JSON.parse(String(d.seen[1]!.init.body)).messages[1].content as string;
    expect(hint).toContain('bad args');
    expect(hint).not.toContain(KEY);
    expect(hint).not.toContain('ghp_aaaa');
    const b = stubFetch(bad);
    const e = await fail(openAiCompatible(cfg, b.f)({ messages: [], tools: [] }));
    expect([e.code, e.message, b.seen.length]).toEqual(['llm_error', 'the LLM request was refused (HTTP 400, tool_use_failed)', 2]);
    const c = stubFetch(() => json(400, { error: { code: 'invalid_request_error' } }));
    await fail(openAiCompatible(cfg, c.f)({ messages: [], tools: [] }));
    expect(c.seen).toHaveLength(1);
  });
  it('without a key it fails as unavailable without calling the provider', async () => {
    const { f, seen } = stubFetch(() => json(200, {}));
    const e = await fail(openAiCompatible({ ...cfg, apiKey: undefined }, f)({ messages: [], tools: [] }));
    expect(e.code).toBe('llm_unavailable');
    expect(seen).toHaveLength(0);
  });
});

// --- agent loop -------------------------------------------------------------------------------------

const TOOLS: Tool[] = [
  { name: 'woo__list_orders', description: '[woo] List orders', inputSchema: { type: 'object', properties: { date: { type: 'string' } } } },
  { name: 'woo__create_product', description: '[woo] Create', inputSchema: { type: 'object', properties: {} } },
];

function stubMcp(results: Record<string, unknown | Error> = {}) {
  const calls: { name: string; arguments?: Record<string, unknown> }[] = [];
  let closed = false;
  const session: McpSession = {
    listTools: async () => ({ tools: TOOLS }),
    callTool: async (req) => {
      calls.push(req);
      const r = results[req.name];
      if (r instanceof Error) throw r;
      return r ?? { content: [{ type: 'text', text: `result of ${req.name}` }] };
    },
    close: async () => { closed = true; },
  };
  return { session, calls, closed: () => closed };
}

/** An LLM that plays a script: each entry answers one round. */
function scripted(rounds: Completion[]) {
  const seen: ChatMessage[][] = [];
  const llm: ChatCompletion = async ({ messages }) => {
    seen.push(structuredClone(messages));
    const next = rounds.shift();
    if (!next) throw new Error('script exhausted');
    return next;
  };
  return { llm, seen };
}
const call = (id: string, name: string, args: string) => ({ id, type: 'function' as const, function: { name, arguments: args } });
const toolRound = (...calls: ReturnType<typeof call>[]): Completion => ({ content: null, toolCalls: calls, finishReason: 'tool_calls' });
const answer = (text: string): Completion => ({ content: text, toolCalls: [], finishReason: 'stop' });
const USER = [{ role: 'user' as const, content: "today's orders?" }];

describe('TC-UI-14-U2 agent loop', () => {
  it('TC-UI-18-U2: the system prompt names unreachable servers only when there are some', () => {
    const now = new Date('2026-10-21T10:00:00Z');
    expect(systemPrompt(now)).not.toContain('cannot be reached');
    expect(systemPrompt(now, ['woo', 'github'])).toContain('These servers cannot be reached right now, so their tools are missing: woo, github.');
  });
  it('lists tools, runs the requested call, feeds the result back and returns the answer with a transcript', async () => {
    const mcp = stubMcp();
    const { llm, seen } = scripted([toolRound(call('c1', 'woo__list_orders', '{"date":"today"}')), answer('One order: #20.')]);
    const out = await runAgent({ llm, connect: async () => mcp.session, now: () => new Date('2026-10-15T10:00:00Z') }, USER);
    expect(out).toMatchObject({ reply: 'One order: #20.', steps: 2, stopped: 'answer' });
    expect(out.toolCalls).toEqual([{ name: 'woo__list_orders', server: 'woo', args: { date: 'today' }, ok: true, ms: expect.any(Number), resultPreview: 'result of woo__list_orders' }]);
    expect(mcp.calls).toEqual([{ name: 'woo__list_orders', arguments: { date: 'today' } }]);
    expect(seen[0]![0]).toMatchObject({ role: 'system' });
    expect((seen[0]![0] as { content: string }).content).toContain('2026-10-15');
    expect(seen[0]![1]).toEqual(USER[0]);
    expect(seen[1]!.slice(-2)).toEqual([
      { role: 'assistant', content: null, tool_calls: [call('c1', 'woo__list_orders', '{"date":"today"}')] },
      { role: 'tool', tool_call_id: 'c1', content: 'result of woo__list_orders' },
    ]);
    expect(mcp.closed()).toBe(true);
  });

  it('bad JSON arguments, invented tool names, tool isError and gateway errors become error results for the model', async () => {
    const mcp = stubMcp({
      woo__create_product: { isError: true, content: [{ type: 'text', text: 'price must be a string' }] },
      woo__list_orders: new Error('MCP error -32602: upstream woo is disabled'),
    });
    const { llm, seen } = scripted([
      toolRound(call('a', 'woo__list_orders', '{not json'), call('b', 'github__delete_repo', '{}'),
        call('c', 'woo__create_product', '{"name":"Mug"}'), call('d', 'woo__list_orders', '{}')),
      answer('Some calls failed.'),
    ]);
    const out = await runAgent({ llm, connect: async () => mcp.session }, USER);
    expect(out.toolCalls.map((c) => [c.name, c.ok, c.resultPreview])).toEqual([
      ['woo__list_orders', false, 'the arguments were not a JSON object'],
      ['github__delete_repo', false, 'unknown tool github__delete_repo'],
      ['woo__create_product', false, 'price must be a string'],
      ['woo__list_orders', false, 'MCP error -32602: upstream woo is disabled'],
    ]);
    expect(mcp.calls.map((c) => c.name)).toEqual(['woo__create_product', 'woo__list_orders']); // invented name never sent
    expect(seen[1]!.filter((m) => m.role === 'tool').every((m) => (m as { content: string }).content.startsWith('error: '))).toBe(true);
  });

  it('stops after maxSteps rounds and caps the number of tool calls', async () => {
    const mcp = stubMcp();
    const many = Array.from({ length: 10 }, (_, i) => call(`c${i}`, 'woo__list_orders', '{}'));
    const { llm, seen } = scripted([toolRound(...many), toolRound(...many), toolRound(...many)]);
    const out = await runAgent({ llm, connect: async () => mcp.session, maxSteps: 3, maxToolCalls: 16 }, USER);
    expect(out.stopped).toBe('max_steps');
    expect(out.toolCalls).toHaveLength(16);
    expect(mcp.calls).toHaveLength(16);
    expect(seen[2]!.filter((m) => m.role === 'tool').at(-1)).toMatchObject({ content: expect.stringMatching(/limit of 16 tool calls/) });
  });

  it('stops at the deadline before another LLM round', async () => {
    let t = 0;
    const mcp = stubMcp();
    const { llm } = scripted([toolRound(call('c1', 'woo__list_orders', '{}')), answer('late')]);
    const slowLlm: ChatCompletion = async (r) => { t += 60_000; return llm(r); };
    const out = await runAgent({ llm: slowLlm, connect: async () => mcp.session, deadlineMs: 30_000, now: () => new Date(t) }, USER);
    expect(out).toMatchObject({ stopped: 'deadline', steps: 1 });
    expect(out.toolCalls).toHaveLength(1);
  });

  it('truncates big results for the model and the preview; closes the session when the LLM throws', async () => {
    const big = 'x'.repeat(RESULT_LIMIT * 2);
    const mcp = stubMcp({ woo__list_orders: { content: [{ type: 'text', text: big }] } });
    const { llm, seen } = scripted([toolRound(call('c1', 'woo__list_orders', '{}')), answer('ok')]);
    const out = await runAgent({ llm, connect: async () => mcp.session }, USER);
    const toolMsg = seen[1]!.at(-1) as { content: string };
    expect(toolMsg.content.length).toBeLessThan(RESULT_LIMIT + 100);
    expect(toolMsg.content).toMatch(new RegExp(`truncated ${RESULT_LIMIT} characters`));
    expect(out.toolCalls[0]!.resultPreview.length).toBeLessThan(600);

    const m2 = stubMcp();
    await expect(runAgent({ llm: async () => { throw new LlmError('llm_rate_limited', 'x'); }, connect: async () => m2.session }, USER)).rejects.toThrow(LlmError);
    expect(m2.closed()).toBe(true);
  });

  it('caps the tool list sent to the model and reports how many were dropped', async () => {
    const tools = Array.from({ length: 5 }, (_, i) => ({ name: `s__t${i}`, inputSchema: { type: 'object' as const } }));
    const session: McpSession = { listTools: async () => ({ tools }), callTool: async () => ({}), close: async () => {} };
    let sent: string[] = []; let report: number[] = [];
    await runAgent({ llm: async (r) => { sent = r.tools.map((t) => t.function.name); return answer('hi'); }, connect: async () => session, maxTools: 3,
      onToolsListed: (c, d) => { report = [c, d]; } }, USER);
    expect(sent).toEqual(['s__t0', 's__t1', 's__t2', FIND_TOOLS]);
    expect(report).toEqual([3, 2]);
  });

  it('resultText joins text parts and names other content; toLlmTool fixes odd schemas', () => {
    expect(resultText({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: '', mimeType: 'image/png' }, { type: 'text', text: 'b' }] }))
      .toEqual({ text: 'a\n[image content omitted]\nb', isError: false });
    expect(resultText({ content: [], structuredContent: { n: 1 } }).text).toBe('{"n":1}');
    expect(resultText(undefined)).toEqual({ text: '(empty result)', isError: false });
    expect(toLlmTool({ name: 'x__y', inputSchema: { type: 'object' } }).function.parameters).toEqual({ type: 'object', properties: {} });
    expect(toLlmTool({ name: 'x__y', description: 'd'.repeat(2000), inputSchema: { type: 'object' } }).function.description).toHaveLength(400);
  });
});

describe('TC-UI-14-U3 many tools: selection within a budget and find_tools (D-019)', () => {
  const tool = (name: string, description: string, pad = 0): Tool =>
    ({ name, description: description + ' '.repeat(pad), inputSchema: { type: 'object', properties: {} } });
  const LISTED: Tool[] = [
    tool('woo__list_products', '[woo] List products'),
    tool('woo__list_orders', '[woo] List orders, filter by date'),
    tool('everything__echo', '[everything] Echo text back'),
    tool('github__issue_write', '[github] Create or update an issue in a repository', 300),
    tool('github__search_code', '[github] Search code across repositories', 300),
  ];
  const all = LISTED.map(toLlmTool);
  const size = (names: string[]) => names.reduce((n, x) => n + JSON.stringify(all.find((t) => t.function.name === x)).length, 0);

  it('keywords drop stop words and fold plurals', () => {
    expect(keywords("What orders came in today? Show the products!")).toEqual(['order', 'today', 'product']);
  });

  it('ranks by relevance, keeps registry order for ties, and never exceeds the budget', () => {
    const names = (text: string, budget: number) => selectTools(all, text, budget).map((t) => t.function.name);
    const smallBudget = size(['woo__list_products', 'woo__list_orders', 'everything__echo']);
    expect(names("today's orders", smallBudget)).toEqual(['woo__list_orders', 'woo__list_products', 'everything__echo']);
    expect(names('open a github issue', size(['github__issue_write']) + 10)).toEqual(['github__issue_write']);
    for (const b of [0, 100, 500, 1000, 5000]) expect(size(names('anything', b))).toBeLessThanOrEqual(b);
  });

  it('find_tools makes matching tools available from the next round; the model then calls them by their real name', async () => {
    const calls: string[] = [];
    const session: McpSession = { listTools: async () => ({ tools: LISTED }), close: async () => {},
      callTool: async (r) => { calls.push(r.name); return { content: [{ type: 'text', text: 'issue #7 created' }] }; } };
    const offered: string[][] = [];
    const { llm } = scripted([
      toolRound(call('f1', FIND_TOOLS, '{"query":"github issue"}')),
      toolRound(call('c1', 'github__issue_write', '{"title":"Orders"}')),
      answer('Created issue #7.'),
    ]);
    const spy: ChatCompletion = async (r) => { offered.push(r.tools.map((t) => t.function.name)); return llm(r); };
    const budget = size(['woo__list_products', 'woo__list_orders', 'everything__echo']);
    const out = await runAgent({ llm: spy, connect: async () => session, toolBudgetChars: budget }, [{ role: 'user', content: 'summarise orders' }]);
    expect(offered[0]).not.toContain('github__issue_write');
    expect(offered[1]).toContain('github__issue_write');
    expect(offered[0]!.at(-1)).toBe(FIND_TOOLS);
    expect(calls).toEqual(['github__issue_write']); // find_tools never reaches /mcp
    expect(out.toolCalls.map((c) => [c.name, c.ok])).toEqual([[FIND_TOOLS, true], ['github__issue_write', true]]);
    expect(out.toolCalls[0]!.resultPreview).toBe('github__issue_write, github__search_code');
    expect(out.reply).toBe('Created issue #7.');
  });

  it('find_tools with no usable keywords or no match says so', async () => {
    const session: McpSession = { listTools: async () => ({ tools: LISTED }), close: async () => {}, callTool: async () => ({}) };
    const { llm, seen } = scripted([toolRound(call('f1', FIND_TOOLS, '{"query":"the and"}'), call('f2', FIND_TOOLS, '{"query":"kubernetes"}')), answer('none')]);
    await runAgent({ llm, connect: async () => session }, USER);
    expect(seen[1]!.filter((m) => m.role === 'tool').map((m) => (m as { content: string }).content))
      .toEqual(['no matching tools; try other keywords', 'no matching tools; try other keywords']);
  });

  it('beyond the best 8, find_tools lists further names; an exact name makes that tool callable', async () => {
    const gh: Tool[] = Array.from({ length: 12 }, (_, i) => tool(`github__tool_${i}`, '[github] does things'));
    gh.push(tool('github__get_me', '[github] Details of the authenticated user'));
    const session: McpSession = { listTools: async () => ({ tools: gh }), close: async () => {}, callTool: async () => ({ content: [{ type: 'text', text: 'Ragx09' }] }) };
    const offered: string[][] = [];
    const { llm, seen } = scripted([
      toolRound(call('f1', FIND_TOOLS, '{"query":"github account"}')),
      toolRound(call('f2', FIND_TOOLS, '{"query":"github__get_me"}')),
      toolRound(call('c1', 'github__get_me', '{}')),
      answer('Ragx09'),
    ]);
    const spy: ChatCompletion = async (r) => { offered.push(r.tools.map((t) => t.function.name)); return llm(r); };
    const out = await runAgent({ llm: spy, connect: async () => session, toolBudgetChars: 0 }, [{ role: 'user', content: 'who am I on github?' }]);
    const first = JSON.parse((seen[1]!.at(-1) as { content: string }).content);
    expect(first.callable_now).toHaveLength(8);
    expect(first.other_matches).toContain('github__get_me');
    expect(offered[1]).not.toContain('github__get_me');
    const second = JSON.parse((seen[2]!.at(-1) as { content: string }).content);
    expect(second.callable_now[0].name).toBe('github__get_me');
    expect(offered[2]).toContain('github__get_me');
    expect(out.reply).toBe('Ragx09');
  });
});

describe('prompt-injection backstop (F-MCP-1)', () => {
  const session: McpSession = { listTools: async () => ({ tools: [] }), callTool: async () => ({}), close: async () => {} };
  const now = () => new Date('2026-10-24T10:00:00Z');

  it('TC-SEC-05-U1: a reply quoting the system prompt (even reformatted) is replaced; normal replies pass', async () => {
    let prompt = '';
    const leak = async (r: { messages: { role: string; content?: unknown }[] }) => {
      prompt = String(r.messages[0]!.content);
      // What the red team got: the prompt dumped as Markdown with changed line breaks.
      const dumped = `**System Prompt (full content):**\n> ${prompt.replace(/\. /g, '.\n> ').toUpperCase()}`;
      return answer(dumped);
    };
    const out = await runAgent({ llm: leak as never, connect: async () => session, now }, USER);
    expect(prompt).toContain('even when the user asks you to');
    expect(out.reply).toBe(PROMPT_LEAK_REPLY);
    expect(leaksSystemPrompt('Here are today\'s orders: #119 (₹499, processing).', prompt)).toBe(false);
    // A single long sentence is enough; short shared phrases ("Answer briefly") are not.
    expect(leaksSystemPrompt('Sure. Call a tool whenever the answer depends on live data; ok', prompt)).toBe(true);
    expect(leaksSystemPrompt('Answer briefly.', prompt)).toBe(false);
    const fine = await runAgent({ llm: (async () => answer('There are 3 products.')) as never, connect: async () => session, now }, USER);
    expect(fine.reply).toBe('There are 3 products.');
  });
});
