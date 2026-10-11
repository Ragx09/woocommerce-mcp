// Runtime configuration from the environment. Secrets come from Kubernetes Secrets via env vars.
export interface Config {
  port: number;
  /** Where we connect to WordPress, e.g. the in-cluster Service http://wordpress.store.svc.cluster.local */
  wooBaseUrl: string;
  /** The WordPress "home" URL. WooCommerce verifies OAuth signatures against it, not against wooBaseUrl. */
  wooSigningUrl: string;
  wooConsumerKey: string;
  wooConsumerSecret: string;
  wooTimeoutMs: number;
  /** Bearer token the gateway must present (defence in depth on top of NetworkPolicy). Empty = disabled. */
  mcpAuthToken: string;
  logLevel: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`missing required environment variable ${name}`);
  return v;
}

function httpUrl(name: string, value: string): string {
  const u = new URL(value);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${name} must be an http(s) URL`);
  return value.replace(/\/+$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const wooBaseUrl = httpUrl('WOO_BASE_URL', required(env, 'WOO_BASE_URL'));
  const mcpAuthToken = env.MCP_AUTH_TOKEN?.trim() ?? '';
  if (!mcpAuthToken && env.MCP_AUTH_DISABLED !== 'true') {
    throw new Error('MCP_AUTH_TOKEN is required (set MCP_AUTH_DISABLED=true only for local experiments)');
  }
  return {
    port: Number(env.PORT ?? 8080),
    wooBaseUrl,
    wooSigningUrl: httpUrl('WOO_SIGNING_URL', env.WOO_SIGNING_URL?.trim() || wooBaseUrl),
    wooConsumerKey: required(env, 'WOO_CONSUMER_KEY'),
    wooConsumerSecret: required(env, 'WOO_CONSUMER_SECRET'),
    wooTimeoutMs: Number(env.WOO_TIMEOUT_MS ?? 10_000),
    mcpAuthToken,
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
