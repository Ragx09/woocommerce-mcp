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
}

function int(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  return n;
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
  };
}
