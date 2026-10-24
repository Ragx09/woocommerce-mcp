// Runtime configuration from the environment. Secrets come from Kubernetes Secrets via env vars.
export interface Config {
  port: number;
  /** BON-03: internal listener for GET /metrics (Prometheus); 0 = off. Never routed by the Ingress. */
  metricsPort: number;
  host: string;
  logLevel: string;
  /** Number of reverse proxies in front of us (Traefik = 1). Used for client IP and protocol. */
  trustProxyHops: number;
  /** Max request body in bytes for /api and /mcp. */
  bodyLimit: number;
  /** Upstream budgets in ms (GW-09, docs/MCP_DESIGN.md §6). */
  upstreamTimeouts: { connectMs: number; listMs: number; callMs: number };
  /** Largest upstream response body the gateway accepts, in bytes (T-08). */
  upstreamMaxResponseBytes: number;
  /** Period of the upstream health loop in ms (GW-10). */
  healthIntervalMs: number;
  /** Session cookie gets the Secure flag (true when the public URL is https). */
  cookieSecure: boolean;
  /** Public origin of the dashboard/API (scheme://host[:port]); unset → browser mutations on /api refused. */
  publicOrigin: string | undefined;
  /** Host names that may resolve to internal addresses (SSRF allowlist, T-06); the seeded upstreams' hosts are added in index.ts. */
  upstreamAllowedHosts: string[];
  /** Chat agent LLM (UI-13, D-012): any OpenAI-compatible chat-completions endpoint. */
  llm: LlmConfig;
}

export interface LlmConfig {
  /** Base URL without the trailing `/chat/completions`, e.g. https://api.groq.com/openai/v1. */
  baseUrl: string;
  model: string;
  /** From the Secret `llm-secrets` (REQ-CHAT-04). Unset → the chat answers "not configured"; nothing else changes. */
  apiKey: string | undefined;
  /** Per LLM request. */
  timeoutMs: number;
  maxTokens: number;
}

function int(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  return n;
}

function bool(name: string, value: string | undefined, fallback: boolean): boolean {
  const v = value?.trim().toLowerCase();
  if (!v) return fallback;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw new Error(`${name} must be true or false`);
}

function origin(name: string, value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  let u: URL;
  try { u = new URL(v); } catch { throw new Error(`${name} must be an origin like https://app.example.com`); }
  if (!['http:', 'https:'].includes(u.protocol) || u.origin !== v) throw new Error(`${name} must be an origin like https://app.example.com`);
  return v;
}

function baseUrl(name: string, value: string | undefined, fallback: string): string {
  const v = value?.trim() || fallback;
  let u: URL;
  try { u = new URL(v); } catch { throw new Error(`${name} must be a URL like https://api.groq.com/openai/v1`); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) {
    throw new Error(`${name} must be a URL like https://api.groq.com/openai/v1 (no credentials, query or fragment)`);
  }
  return v.replace(/\/+$/, '');
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const logLevel = env.LOG_LEVEL?.trim() || 'info';
  if (!LOG_LEVELS.includes(logLevel)) throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);
  return {
    port: int('PORT', env.PORT, 8080, 1, 65535),
    metricsPort: int('METRICS_PORT', env.METRICS_PORT, 9464, 0, 65535),
    host: env.HOST?.trim() || '0.0.0.0',
    logLevel,
    trustProxyHops: int('TRUST_PROXY_HOPS', env.TRUST_PROXY_HOPS, 1, 0, 5),
    bodyLimit: int('BODY_LIMIT_BYTES', env.BODY_LIMIT_BYTES, 1024 * 1024, 1024, 10 * 1024 * 1024),
    upstreamTimeouts: {
      connectMs: int('UPSTREAM_CONNECT_TIMEOUT_MS', env.UPSTREAM_CONNECT_TIMEOUT_MS, 2_000, 100, 30_000),
      listMs: int('UPSTREAM_LIST_TIMEOUT_MS', env.UPSTREAM_LIST_TIMEOUT_MS, 3_000, 100, 60_000),
      callMs: int('UPSTREAM_CALL_TIMEOUT_MS', env.UPSTREAM_CALL_TIMEOUT_MS, 15_000, 100, 300_000),
    },
    upstreamMaxResponseBytes: int('UPSTREAM_MAX_RESPONSE_BYTES', env.UPSTREAM_MAX_RESPONSE_BYTES, 4 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024),
    healthIntervalMs: int('HEALTH_INTERVAL_MS', env.HEALTH_INTERVAL_MS, 10_000, 1_000, 300_000),
    cookieSecure: bool('COOKIE_SECURE', env.COOKIE_SECURE, false),
    publicOrigin: origin('PUBLIC_ORIGIN', env.PUBLIC_ORIGIN),
    upstreamAllowedHosts: (env.UPSTREAM_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean),
    llm: {
      baseUrl: baseUrl('LLM_BASE_URL', env.LLM_BASE_URL, 'https://api.groq.com/openai/v1'),
      model: env.LLM_MODEL?.trim() || 'openai/gpt-oss-120b',
      apiKey: env.LLM_API_KEY?.trim() || undefined,
      timeoutMs: int('LLM_TIMEOUT_MS', env.LLM_TIMEOUT_MS, 30_000, 1_000, 120_000),
      maxTokens: int('LLM_MAX_OUTPUT', env.LLM_MAX_OUTPUT, 1_024, 64, 16_384),
    },
  };
}
