// Runtime configuration from the environment. Secrets come from Kubernetes Secrets via env vars.
export interface Config {
  port: number;
  host: string;
  logLevel: string;
  /** Number of reverse proxies in front of us (Traefik = 1). Used for client IP and protocol. */
  trustProxyHops: number;
  /** Max request body in bytes for /api and /mcp. */
  bodyLimit: number;
  /** TEMPORARY shared key for /mcp until per-user API keys (AUTH-08). Unset → /mcp refuses all. */
  mcpDevKey: string | undefined;
  /** Upstream budgets in ms (GW-09, docs/MCP_DESIGN.md §6). */
  upstreamTimeouts: { connectMs: number; listMs: number; callMs: number };
  /** Period of the upstream health loop in ms (GW-10). */
  healthIntervalMs: number;
  /** Session cookie gets the Secure flag (true when the public URL is https). */
  cookieSecure: boolean;
  /** Public origin of the dashboard/API (scheme://host[:port]); unset → browser mutations on /api refused. */
  publicOrigin: string | undefined;
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

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const logLevel = env.LOG_LEVEL?.trim() || 'info';
  if (!LOG_LEVELS.includes(logLevel)) throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);
  const mcpDevKey = env.MCP_DEV_KEY?.trim() || undefined;
  if (mcpDevKey && mcpDevKey.length < 32) throw new Error('MCP_DEV_KEY must be at least 32 characters');
  return {
    port: int('PORT', env.PORT, 8080, 1, 65535),
    host: env.HOST?.trim() || '0.0.0.0',
    logLevel,
    trustProxyHops: int('TRUST_PROXY_HOPS', env.TRUST_PROXY_HOPS, 1, 0, 5),
    bodyLimit: int('BODY_LIMIT_BYTES', env.BODY_LIMIT_BYTES, 1024 * 1024, 1024, 10 * 1024 * 1024),
    mcpDevKey,
    upstreamTimeouts: {
      connectMs: int('UPSTREAM_CONNECT_TIMEOUT_MS', env.UPSTREAM_CONNECT_TIMEOUT_MS, 2_000, 100, 30_000),
      listMs: int('UPSTREAM_LIST_TIMEOUT_MS', env.UPSTREAM_LIST_TIMEOUT_MS, 3_000, 100, 60_000),
      callMs: int('UPSTREAM_CALL_TIMEOUT_MS', env.UPSTREAM_CALL_TIMEOUT_MS, 15_000, 100, 300_000),
    },
    healthIntervalMs: int('HEALTH_INTERVAL_MS', env.HEALTH_INTERVAL_MS, 10_000, 1_000, 300_000),
    cookieSecure: bool('COOKIE_SECURE', env.COOKIE_SECURE, false),
    publicOrigin: origin('PUBLIC_ORIGIN', env.PUBLIC_ORIGIN),
  };
}
