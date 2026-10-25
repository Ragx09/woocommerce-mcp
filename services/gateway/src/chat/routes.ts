// UI-14: POST /api/chat (session). Runs the agent loop for the signed-in user: it mints a short-lived
// internal token (UI-15) and connects to this process's own /mcp over loopback, so the agent's calls are
// authorized, routed and audited exactly like the user's external MCP client, with source=chat.
//
// Guard rails (one member must not be able to use up the team's LLM quota — THREAT_MODEL T-23):
// one chat request per user at a time, and a window of requests per user. Both are shared by all
// replicas when the limiter is the Postgres one (BON-04, ratelimit.ts).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { VERSION } from '../app.js';
import type { InternalTokenSigner } from '../auth/internal-token.js';
import { MemoryRateLimiter, type RateLimiter, type Release } from '../ratelimit.js';
import { DEFAULT_DEADLINE_MS, runAgent, type McpSession } from './agent.js';
import { LlmError, type ChatCompletion } from './llm.js';

export interface ChatDeps {
  /** null → the chat is disabled (no LLM key); the route answers 503. */
  llm: ChatCompletion | null;
  signer: InternalTokenSigner;
  /** The gateway's own /mcp over loopback, e.g. http://127.0.0.1:8080/mcp. */
  mcpUrl: () => string;
  limits?: { windowMs?: number; perWindow?: number };
  /** Shared limiter (PgRateLimiter in the gateway); defaults to one in this process's memory. */
  limiter?: RateLimiter;
  /** UI-18: enabled servers the health monitor has as unreachable right now (none if not given). */
  unavailable?: (user: { id: string; role: 'admin' | 'member' }) => Promise<UnavailableServer[]>;
  agent?: { maxSteps?: number; deadlineMs?: number };
}

/** Slug + display name only: what the Servers page already shows every signed-in user. */
export interface UnavailableServer { server: string; name: string }

interface ChatBody { messages: { role: 'user' | 'assistant'; content: string }[] }

const body = {
  type: 'object', required: ['messages'], additionalProperties: false,
  properties: {
    messages: {
      type: 'array', minItems: 1, maxItems: 40,
      items: {
        type: 'object', required: ['role', 'content'], additionalProperties: false,
        properties: { role: { type: 'string', enum: ['user', 'assistant'] }, content: { type: 'string', minLength: 1, maxLength: 8000 } },
      },
    },
  },
} as const;

const LLM_STATUS: Record<LlmError['code'], number> = { llm_rate_limited: 429, llm_timeout: 504, llm_unavailable: 502, llm_error: 502 };

export function registerChatRoutes(app: FastifyInstance, deps: ChatDeps): void {
  const limiter = deps.limiter ?? new MemoryRateLimiter();
  const windowMs = deps.limits?.windowMs ?? 10 * 60_000;
  const perWindow = deps.limits?.perWindow ?? 30;
  // Longer than the agent's own deadline: a pod that dies mid-chat frees the user after this.
  const holdMs = (deps.agent?.deadlineMs ?? DEFAULT_DEADLINE_MS) + 30_000;

  app.post<{ Body: ChatBody }>('/api/chat', { config: { access: 'session' }, schema: { body } }, async (req, reply) => {
    const user = req.user!;
    if (!deps.llm) return reply.code(503).send({ error: 'chat_disabled', message: 'the chat agent is not configured on this server' });
    const msgs = req.body.messages;
    if (msgs.at(-1)!.role !== 'user') {
      return reply.code(400).send({ error: 'validation_failed', message: 'the last message must be from the user' });
    }
    const release: Release | null = await limiter.lease(`chat:busy:${user.id}`, holdMs);
    if (!release) return reply.code(429).send({ error: 'chat_busy', message: 'wait for your previous message to finish' });
    const quota = await limiter.hit(`chat:user:${user.id}`, perWindow, windowMs).catch(async (e) => { await release(); throw e; });
    if (!quota.allowed) {
      await release();
      const wait = quota.retryAfterS;
      return reply.code(429).header('retry-after', String(wait))
        .send({ error: 'rate_limited', message: `too many chat messages; try again in ${wait} s`, retryAfter: wait });
    }

    const started = Date.now();
    const llm = deps.llm;
    const connect = async (): Promise<McpSession> => {
      const token = deps.signer.mint(user.id);
      const client = new Client({ name: 'dashboard-chat', version: VERSION });
      await client.connect(new StreamableHTTPClientTransport(new URL(deps.mcpUrl()), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }));
      return client as unknown as McpSession;
    };
    let offered = { count: 0, notOffered: 0 };
    try {
      // A failed lookup must not fail the chat; it only loses the hint.
      const unavailable = await (deps.unavailable?.({ id: req.user!.id, role: req.user!.role }) ?? Promise.resolve([])).catch(() => [] as UnavailableServer[]);
      const result = await runAgent({
        llm, connect, maxSteps: deps.agent?.maxSteps, deadlineMs: deps.agent?.deadlineMs, unavailable: unavailable.map((u) => u.server),
        onToolsListed: (count, notOffered) => { offered = { count, notOffered }; }, // the rest is reachable via find_tools
      }, msgs);
      // Tool names and outcomes only: no message text, arguments or results in the log.
      req.log.info({ steps: result.steps, stopped: result.stopped, ms: Date.now() - started, toolsOffered: offered,
        tools: result.toolCalls.map((c) => `${c.name}:${c.ok ? 'ok' : 'error'}`), unavailable: unavailable.map((u) => u.server) }, 'chat');
      return { reply: result.reply, toolCalls: result.toolCalls, stopped: result.stopped, unavailable };
    } catch (e) {
      if (e instanceof LlmError) {
        req.log.warn({ code: e.code, detail: e.message, ms: Date.now() - started }, 'chat: llm failed'); // message = status + provider code only
        if (e.retryAfterS !== undefined) reply.header('retry-after', String(e.retryAfterS));
        return reply.code(LLM_STATUS[e.code]).send({ error: e.code, message: e.message });
      }
      req.log.error({ err: (e as Error).message, ms: Date.now() - started }, 'chat: failed');
      return reply.code(502).send({ error: 'chat_failed', message: 'the chat agent could not reach the tools; try again' });
    } finally {
      await release().catch((e: Error) => req.log.warn({ err: e.message }, 'chat: releasing the busy lease failed (expires by itself)'));
    }
  });
}
