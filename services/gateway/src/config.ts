// Runtime configuration from the environment. Secrets come from Kubernetes Secrets via env vars.
export interface Config {
  port: number;
  host: string;
  logLevel: string;
  /** Number of reverse proxies in front of us (Traefik = 1). Used for client IP and protocol. */
  trustProxyHops: number;
  /** Max request body in bytes for /api and /mcp. */
  bodyLimit: number;
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
  return {
    port: int('PORT', env.PORT, 8080, 1, 65535),
    host: env.HOST?.trim() || '0.0.0.0',
    logLevel,
    trustProxyHops: int('TRUST_PROXY_HOPS', env.TRUST_PROXY_HOPS, 1, 0, 5),
    bodyLimit: int('BODY_LIMIT_BYTES', env.BODY_LIMIT_BYTES, 1024 * 1024, 1024, 10 * 1024 * 1024),
  };
}
