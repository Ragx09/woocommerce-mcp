// UI-14 / D-012: a minimal OpenAI-compatible chat-completions client (plain fetch, no SDK). Works with
// Groq and OpenRouter by changing `baseUrl`/`model` (UI-13). The API key is only ever put in the
// Authorization header; errors carry the HTTP status and a short provider error code, never response
// text (which could echo request data) and never the key.
import type { LlmConfig } from '../config.js';
import { scrubString } from '../logger.js';

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export interface LlmTool { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }

export interface Completion { content: string | null; toolCalls: ToolCall[]; finishReason: string | null }
export type ChatCompletion = (req: { messages: ChatMessage[]; tools: LlmTool[] }) => Promise<Completion>;

export type LlmErrorCode = 'llm_rate_limited' | 'llm_timeout' | 'llm_unavailable' | 'llm_error';

export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode, message: string, readonly retryAfterS?: number, readonly providerCode?: string,
    /** For the model only (never logged or returned): why the provider refused its tool call. */
    readonly modelHint?: string,
    readonly httpStatus?: number,
  ) { super(message); }
}

/**
 * Groq checks tool-call arguments against the tool's JSON schema and refuses the whole completion with
 * 400 `tool_use_failed` when they do not match (TC-UI-16-1: gpt-oss-120b asked woo__list_orders for
 * per_page 100 > maximum 50 in 3 of 5 tries). One retry, telling the model what was wrong, fixed it.
 */
const TOOL_USE_FAILED = 'tool_use_failed';
const HINT_LIMIT = 400;

const SAFE_CODE = /^[a-z0-9_]{1,40}$/;

/** `Retry-After` in seconds (delta form only), capped at 10 min; undefined if absent or not a number. */
function retryAfter(h: string | null): number | undefined {
  const n = h === null ? NaN : Number(h);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.ceil(n), 600) : undefined;
}

export function openAiCompatible(cfg: LlmConfig, fetchImpl: typeof fetch = fetch): ChatCompletion {
  const once = completeOnce(cfg, fetchImpl);
  return async (req) => {
    try {
      return await once(req);
    } catch (e) {
      if (!(e instanceof LlmError) || e.providerCode !== TOOL_USE_FAILED) throw e;
      const why = e.modelHint ? `: ${e.modelHint}` : '';
      return once({ ...req, messages: [...req.messages, { role: 'system', content:
        `Your previous tool call was rejected by the tool's input schema${why}. Call the tool again with arguments that follow its schema exactly (types, minimum/maximum, enum, pattern), or answer without it.` }] });
    }
  };
}

/**
 * Primary first; the fallback gets the same request once when the primary is rate-limited, down, slow or says the request
 * is too large for it (free tiers differ in limits). Refusals of the request itself (other 4xx) are not retried elsewhere.
 * If the fallback fails too, the primary's error is reported (its Retry-After is the useful one).
 */
export function withFallback(primary: ChatCompletion, fallback: ChatCompletion | null, onFallback?: (code: string) => void): ChatCompletion {
  if (!fallback) return primary;
  return async (req) => {
    try {
      return await primary(req);
    } catch (e) {
      if (!(e instanceof LlmError) || !(e.code !== 'llm_error' || e.httpStatus === 413)) throw e;
      onFallback?.(e.code);
      try { return await fallback(req); } catch { throw e; }
    }
  };
}

function completeOnce(cfg: LlmConfig, fetchImpl: typeof fetch): ChatCompletion {
  return async ({ messages, tools }) => {
    if (!cfg.apiKey) throw new LlmError('llm_unavailable', 'the chat agent is not configured (no LLM API key)');
    let res: Response;
    try {
      res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model, messages, max_tokens: cfg.maxTokens,
          ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
        }),
        redirect: 'error', // the key must not follow a redirect to another host
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (e) {
      const name = (e as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new LlmError('llm_timeout', `the LLM did not answer within ${cfg.timeoutMs / 1000} s`);
      }
      throw new LlmError('llm_unavailable', 'the LLM provider could not be reached');
    }
    if (!res.ok) {
      // Only a short machine code from the provider's error body is kept (e.g. Groq "tool_use_failed").
      let code = '';
      let hint: string | undefined;
      try {
        const body = (await res.json()) as { error?: { code?: unknown; type?: unknown; message?: unknown } };
        const c = body.error?.code ?? body.error?.type;
        if (typeof c === 'string' && SAFE_CODE.test(c)) code = c;
        // Groq's message names the tool, the parameter and the schema rule the model broke.
        if (code === TOOL_USE_FAILED && typeof body.error?.message === 'string') {
          // It goes back into the prompt, and the model could repeat it to the user: no key, no credentials.
          const msg = cfg.apiKey ? body.error.message.split(cfg.apiKey).join('[redacted]') : body.error.message;
          hint = scrubString(msg.replace(/[\u0000-\u001f]+/g, ' ')).slice(0, HINT_LIMIT);
        }
      } catch { /* not JSON */ }
      if (res.status === 429) {
        const s = retryAfter(res.headers.get('retry-after'));
        throw new LlmError('llm_rate_limited', `the LLM provider's rate limit was reached${s !== undefined ? `; try again in ${s} s` : '; try again shortly'}`, s);
      }
      if (res.status >= 500) throw new LlmError('llm_unavailable', `the LLM provider failed (HTTP ${res.status})`);
      if (res.status === 413) {
        throw new LlmError('llm_error', `the conversation is too large for the LLM provider's limits (HTTP 413${code ? `, ${code}` : ''}); start a new chat or ask a narrower question`, undefined, code || undefined, undefined, 413);
      }
      throw new LlmError('llm_error', `the LLM request was refused (HTTP ${res.status}${code ? `, ${code}` : ''})`, undefined, code || undefined, hint);
    }
    let body: { choices?: { message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }[] };
    try { body = await res.json() as typeof body; } catch { throw new LlmError('llm_error', 'the LLM returned an unreadable response'); }
    const choice = body.choices?.[0];
    if (!choice?.message) throw new LlmError('llm_error', 'the LLM returned no message');
    const toolCalls = Array.isArray(choice.message.tool_calls)
      ? (choice.message.tool_calls as Partial<ToolCall>[]).filter((c): c is ToolCall =>
        typeof c?.id === 'string' && typeof c.function?.name === 'string' && typeof c.function.arguments === 'string')
        .map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.function.name, arguments: c.function.arguments } }))
      : [];
    return {
      content: typeof choice.message.content === 'string' ? choice.message.content : null,
      toolCalls,
      finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    };
  };
}
