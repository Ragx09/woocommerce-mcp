// Fastify app factory. Modules (mcp/, upstreams/, auth/, audit/, chat/, api/) register onto this in later tasks (D-004).
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Config } from './config.js';
import { genReqId, loggerOptions } from './logger.js';

export const VERSION = '0.1.0';

/** A named dependency check for /readyz (Postgres, …). Throws or returns false when not ready. */
export interface ReadinessCheck {
  name: string;
  check: () => Promise<boolean>;
}

export interface AppOptions {
  readinessChecks?: ReadinessCheck[];
  /** Overrides for tests (e.g. a log stream). */
  logger?: FastifyServerOptions['logger'];
}

const READY_TIMEOUT_MS = 2_000;

/**
 * SEC-07 / F-WEB-9: headers on every gateway response (JSON only, never rendered): no MIME sniffing, no
 * framing, no caching (a new API key is in a response body), no referrer. HSTS when the request came in over
 * TLS (Traefik terminates it and sets X-Forwarded-Proto; trustProxy decides whether we believe it).
 */
export function securityHeaders(https: boolean): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    ...(https ? { 'strict-transport-security': 'max-age=31536000' } : {}),
  };
}

async function runCheck(c: ReadinessCheck): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS); });
  try {
    return await Promise.race([c.check().catch(() => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function buildApp(cfg: Config, opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? loggerOptions(cfg.logLevel),
    trustProxy: (_addr: string, hop: number) => hop < cfg.trustProxyHops, // trust exactly N proxies (Traefik)
    bodyLimit: cfg.bodyLimit,
    requestIdHeader: false, // never trust a client-supplied request id; generate our own
    genReqId, // random UUID: unique across replicas and restarts (GW-17)
    // Unknown body fields are an error (400), not silently dropped: `additionalProperties: false` means it.
    ajv: { customOptions: { removeAdditional: false } },
  });
  // Every response names its request id, so a user can quote it and we can find the log lines.
  app.addHook('onRequest', async (req, reply) => { reply.header('x-request-id', req.id).headers(securityHeaders(req.protocol === 'https')); });
  const checks = opts.readinessChecks ?? [];

  // Probes: cheap, unauthenticated, not routed by the Ingress.
  // Logged only on warn and above: kubelet calls them every few seconds.
  app.get('/healthz', { logLevel: 'warn' }, async () => ({ status: 'ok', version: VERSION }));
  app.get('/readyz', { logLevel: 'warn' }, async (_req, reply) => {
    const results = await Promise.all(checks.map(async (c) => [c.name, await runCheck(c)] as const));
    const failed = results.filter(([, ok]) => !ok).map(([name]) => name);
    if (failed.length) return reply.code(503).send({ status: 'not_ready', failed });
    return { status: 'ready' };
  });

  // Uniform error shape from docs/API_CONTRACTS.md: { error, message }.
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: 'not_found', message: `${req.method} ${req.url.split('?')[0]} not found` });
  });
  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, 'request failed');
      return reply.code(status).send({ error: 'internal', message: 'internal error' }); // no internals to clients
    }
    if (err.validation) return reply.code(400).send({ error: 'validation_failed', message: err.message, issues: err.validation });
    const code = status === 413 ? 'payload_too_large' : status === 415 ? 'unsupported_media_type' : 'bad_request';
    return reply.code(status).send({ error: code, message: err.message });
  });

  return app;
}
