// UI-14: POST /api/chat (session). Runs the agent loop for the signed-in user: it mints a short-lived
// internal token (UI-15) and connects to this process's own /mcp over loopback, so the agent's calls are
// authorized, routed and audited exactly like the user's external MCP client, with source=chat.
//
// Guard rails (one member must not be able to use up the team's LLM quota — THREAT_MODEL T-23):
// one chat request per user at a time, and a sliding window of requests per user.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { VERSION } from '../app.js';
import type { InternalTokenSigner } from '../auth/internal-token.js';
import { runAgent, type McpSession } from './agent.js';
import { LlmError, type ChatCompletion } from './llm.js';

export interface ChatDeps {
  /** null → the chat is disabled (no LLM key); the route answers 503. */
  llm: ChatCompletion | null;
  signer: InternalTokenSigner;
  /** The gateway's own /mcp over loopback, e.g. http://127.0.0.1:8080/mcp. */
  mcpUrl: () => string;
  limits?: { windowMs?: number; perWindow?: number };
  agent?: { maxSteps?: number; deadlineMs?: number };
}

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

/** Per-user sliding window, in memory per replica (like the login limiter). */
class UserWindow {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly windowMs: number, private readonly max: number) {}
  /** Seconds to wait, or 0 and the hit is recorded. */
  take(userId: string, t = Date.now()): number {
    const recent = (this.hits.get(userId) ?? []).filter((x) => x > t - this.windowMs);
    if (recent.length >= this.max) return Math.ceil((recent[0]! + this.windowMs - t) / 1000);
    recent.push(t);
    this.hits.set(userId, recent);
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.every((x) => x <= t - this.windowMs)) this.hits.delete(k);
    return 0;
  }
}

export function registerChatRoutes(app: FastifyInstance, deps: ChatDeps): void {
  const window = new UserWindow(deps.limits?.windowMs ?? 10 * 60_000, deps.limits?.perWindow ?? 30);
  const busy = new Set<string>();

  app.post<{ Body: ChatBody }>('/api/chat', { config: { access: 'session' }, schema: { body } }, async (req, reply) => {
    const user = req.user!;
    if (!deps.llm) return reply.code(503).send({ error: 'chat_disabled', message: 'the chat agent is not configured on this server' });
    const msgs = req.body.messages;
    if (msgs.at(-1)!.role !== 'user') {
      return reply.code(400).send({ error: 'validation_failed', message: 'the last message must be from the user' });
    }
    if (busy.has(user.id)) return reply.code(429).send({ error: 'chat_busy', message: 'wait for your previous message to finish' });
    const wait = window.take(user.id);
    if (wait) {
      return reply.code(429).header('retry-after', String(wait))
        .send({ error: 'rate_limited', message: `too many chat messages; try again in ${wait} s`, retryAfter: wait });
    }

    busy.add(user.id);
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
      const result = await runAgent({
        llm, connect, maxSteps: deps.agent?.maxSteps, deadlineMs: deps.agent?.deadlineMs,
        onToolsListed: (count, notOffered) => { offered = { count, notOffered }; }, // the rest is reachable via find_tools
      }, msgs);
      // Tool names and outcomes only: no message text, arguments or results in the log.
      req.log.info({ steps: result.steps, stopped: result.stopped, ms: Date.now() - started, toolsOffered: offered,
        tools: result.toolCalls.map((c) => `${c.name}:${c.ok ? 'ok' : 'error'}`) }, 'chat');
      return { reply: result.reply, toolCalls: result.toolCalls, stopped: result.stopped };
    } catch (e) {
      if (e instanceof LlmError) {
        req.log.warn({ code: e.code, ms: Date.now() - started }, 'chat: llm failed');
        if (e.retryAfterS !== undefined) reply.header('retry-after', String(e.retryAfterS));
        return reply.code(LLM_STATUS[e.code]).send({ error: e.code, message: e.message });
      }
      req.log.error({ err: (e as Error).message, ms: Date.now() - started }, 'chat: failed');
      return reply.code(502).send({ error: 'chat_failed', message: 'the chat agent could not reach the tools; try again' });
    } finally {
      busy.delete(user.id);
    }
  });
}
