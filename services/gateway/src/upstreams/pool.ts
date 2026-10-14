// GW-04: one connected MCP client per enabled upstream (D-002 findings).
// - Lazy: a client connects on first use; concurrent callers share the same connect attempt.
// - Credentials are decrypted only here, in memory, and sent as headers to that upstream only.
//   Nothing from the inbound request (e.g. the user's API key) is ever forwarded (T-04).
// - Rebuilt when the upstream row changes (URL, auth, credential, enable flag); closed when removed.
// - Sessionful upstreams (server-everything) lose their session when they restart, so a request that
//   fails at the transport level is retried once on a fresh connection.
// - TCP connect is bounded by undici's connect timeout (the SDK request timeout does not cover it).
// - Redirects are refused (GW-12): following one could send the credential to another server (undici
//   drops Authorization on a cross-origin redirect but keeps custom headers like X-Api-Key). The SDK
//   (1.32) already stops cross-origin redirects; `redirect: 'error'` is a second layer that does not
//   depend on the SDK default. Registered URLs are exact endpoints, so no redirect is expected.
// - SSRF guard at connect time (T-06, `ssrf` option): every DNS answer the agent connects to and every
//   literal-IP URL is checked against the policy (ssrf.ts), so DNS rebinding or a row written around
//   the API cannot reach internal addresses.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { Agent, fetch as undiciFetch } from 'undici';
import type { Upstream } from '../db/schema.js';
import { decryptCredential, type CredentialKey } from '../crypto/credentials.js';
import { checkLiteralHost, guardedLookup, type SsrfPolicy } from './ssrf.js';

export const CLIENT_INFO = { name: 'mcp-gateway', version: '0.1.0' };

export interface PoolOptions {
  key: CredentialKey;
  /** TCP connect + MCP initialize budget (docs/MCP_DESIGN.md §6: 2 s). */
  connectTimeoutMs?: number;
  /** Refuse internal addresses unless allowlisted (production). Unset: no check (tests with local fakes). */
  ssrf?: SsrfPolicy;
  log?: { warn: (obj: object, msg: string) => void; info: (obj: object, msg: string) => void };
}

/** Thrown for problems reaching an upstream; message is safe to show (no URL secrets, no credentials). */
export class UpstreamUnavailableError extends Error {
  constructor(public readonly slug: string, reason: string) {
    super(`upstream ${slug} unreachable: ${reason}`);
  }
}

/** An upstream did not finish within its budget (GW-09). The message is safe to show. */
export class UpstreamTimeoutError extends Error {
  constructor(public readonly slug: string, public readonly ms: number) {
    super(`upstream ${slug} timed out after ${ms} ms`);
  }
}

/**
 * Runs `fn` under one deadline (GW-09). It covers everything `fn` does — connecting, the request and
 * the pool's single reconnect — so the caller never waits longer than `ms`. On expiry the signal is
 * aborted (the SDK then sends notifications/cancelled to the upstream) and UpstreamTimeoutError is thrown.
 */
export async function withDeadline<T>(slug: string, ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new UpstreamTimeoutError(slug, ms));
      abort.abort();
    }, ms);
  });
  const work = fn(abort.signal);
  work.catch(() => {}); // after the deadline wins, the late rejection is expected and not unhandled
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

interface Entry {
  row: Upstream;
  version: string;
  client?: Client;
  connecting?: Promise<Client>;
}

/** Everything that, when changed, requires a new connection. */
export const versionOf = (u: Upstream) =>
  JSON.stringify([u.url, u.authType, u.authHeader, u.credentialEnc?.ciphertext ?? null, u.updatedAt.toISOString()]);

/** Errors that mean "the connection/session is bad", as opposed to the upstream answering with an error. */
export function isTransportError(e: unknown): boolean {
  if (e instanceof McpError) return false; // a JSON-RPC error *from* the upstream: it is alive
  if (e instanceof StreamableHTTPError) return true; // HTTP-level, e.g. 404 "session not found"
  return e instanceof TypeError || (e instanceof Error && /fetch failed|ECONN|socket|closed|terminated/i.test(e.message));
}

/**
 * Stricter retry rule for tools/call (GW-08): only when the upstream certainly did not run the tool,
 * i.e. the connection was refused or the session was unknown (HTTP 404). A reset or timeout after the
 * request was sent may mean it ran, and repeating e.g. create_product would duplicate it.
 */
export function isSafeCallRetry(e: unknown): boolean {
  if (e instanceof StreamableHTTPError) return e.code === 404;
  const err = e as { code?: string; cause?: { code?: string } };
  return (err.cause?.code ?? err.code) === 'ECONNREFUSED';
}

export class UpstreamPool {
  private readonly entries = new Map<string, Entry>();
  private readonly dispatcher: Agent;
  private readonly connectTimeoutMs: number;

  constructor(private readonly opts: PoolOptions) {
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 2_000;
    // bodyTimeout 0: the optional server→client SSE stream may stay open; request budgets are
    // enforced per call by the SDK `timeout` option (GW-09).
    const lookup = opts.ssrf ? guardedLookup(opts.ssrf) : undefined;
    this.dispatcher = new Agent({ connect: { timeout: this.connectTimeoutMs, ...(lookup ? { lookup } : {}) }, bodyTimeout: 0, keepAliveTimeout: 30_000 });
  }

  /** Align the pool with the current upstream rows. Disabled or removed upstreams are closed. */
  async sync(rows: Upstream[]): Promise<void> {
    const wanted = new Map(rows.filter((r) => r.enabled).map((r) => [r.id, r]));
    const closing: Promise<void>[] = [];
    for (const [id, entry] of this.entries) {
      const row = wanted.get(id);
      if (!row || versionOf(row) !== entry.version) {
        this.entries.delete(id);
        closing.push(this.closeEntry(entry));
      }
    }
    // Rebuild in registry order, so tools/list order follows the DB (stable across replicas and
    // after a disable/enable), not the order in which entries happened to be created.
    const kept = new Map(this.entries);
    this.entries.clear();
    for (const [id, row] of wanted) this.entries.set(id, kept.get(id) ?? { row, version: versionOf(row) });
    await Promise.all(closing);
  }

  /** Upstreams currently managed (enabled). */
  upstreams(): Upstream[] {
    return [...this.entries.values()].map((e) => e.row);
  }

  isConnected(id: string): boolean {
    return !!this.entries.get(id)?.client;
  }

  /**
   * Runs `fn` with a connected client. On a transport error the connection is replaced and `fn`
   * is retried once, but only when `retry` allows it (tools/call is not always safe to repeat).
   */
  async withClient<T>(id: string, fn: (c: Client) => Promise<T>, retry: (e: unknown) => boolean = isTransportError): Promise<T> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`upstream ${id} is not enabled`);
    const client = await this.connect(entry);
    try {
      return await fn(client);
    } catch (e) {
      if (!retry(e) || this.entries.get(id) !== entry) throw e;
      this.opts.log?.warn({ upstream: entry.row.slug, err: (e as Error).message }, 'upstream request failed, reconnecting once');
      await this.drop(entry);
      return fn(await this.connect(entry));
    }
  }

  async close(): Promise<void> {
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(all.map((e) => this.closeEntry(e)));
    await this.dispatcher.close();
  }

  private connect(entry: Entry): Promise<Client> {
    if (entry.client) return Promise.resolve(entry.client);
    entry.connecting ??= this.open(entry.row)
      .then((client) => {
        // The entry may have been replaced (sync) while we were connecting: do not leak this client.
        if (this.entries.get(entry.row.id) !== entry) {
          void client.close();
          throw new UpstreamUnavailableError(entry.row.slug, 'configuration changed while connecting');
        }
        entry.client = client;
        client.onclose = () => { if (entry.client === client) entry.client = undefined; };
        this.opts.log?.info({ upstream: entry.row.slug }, 'upstream connected');
        return client;
      })
      .finally(() => { entry.connecting = undefined; });
    return entry.connecting;
  }

  private async open(row: Upstream): Promise<Client> {
    const headers = upstreamHeaders(this.opts.key, row);
    const dispatcher = this.dispatcher;
    const ssrf = this.opts.ssrf;
    const transport = new StreamableHTTPClientTransport(new URL(row.url), {
      requestInit: { headers },
      fetch: (async (url: string | URL, init?: RequestInit) => {
        if (ssrf) checkLiteralHost(url, ssrf); // IP hosts never reach the agent's lookup
        return undiciFetch(url, { ...(init as object), dispatcher, redirect: 'error' });
      }) as unknown as typeof fetch,
    });
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    try {
      await client.connect(transport, { timeout: this.connectTimeoutMs });
      return client;
    } catch (e) {
      await client.close().catch(() => {});
      throw new UpstreamUnavailableError(row.slug, safeReason(e));
    }
  }

  private async drop(entry: Entry): Promise<void> {
    const client = entry.client;
    entry.client = undefined;
    if (client) await client.close().catch(() => {});
  }

  private async closeEntry(entry: Entry): Promise<void> {
    const pending = entry.connecting;
    await this.drop(entry);
    if (pending) await pending.then((c) => c.close(), () => {}).catch(() => {});
  }
}

/** Printable ASCII only: no CR/LF (header injection) and nothing undici would reject. */
const HEADER_VALUE = /^[\x20-\x7e]{1,4096}$/;

/**
 * The headers sent to one upstream (GW-12): our user agent plus that upstream's own stored credential,
 * decrypted here and only here. Built from the row alone, so nothing from the inbound request (the
 * client's API key) can end up in it (T-04). Failures name the upstream, never the value.
 */
export function upstreamHeaders(key: CredentialKey, row: Upstream): Record<string, string> {
  const headers: Record<string, string> = { 'user-agent': `${CLIENT_INFO.name}/${CLIENT_INFO.version}` };
  if (row.authType === 'none' || !row.credentialEnc) return headers;
  let secret: string;
  try {
    secret = decryptCredential(key, row.slug, row.credentialEnc);
  } catch {
    throw new UpstreamUnavailableError(row.slug, 'stored credential cannot be decrypted (wrong CREDENTIALS_KEY?)');
  }
  if (!HEADER_VALUE.test(secret)) throw new UpstreamUnavailableError(row.slug, 'stored credential is not a valid header value');
  if (row.authType === 'bearer') headers.authorization = `Bearer ${secret}`;
  else if (row.authHeader) headers[row.authHeader.toLowerCase()] = secret;
  return headers;
}

/** A short reason without URLs or headers (they could contain secrets in query strings). */
export function safeReason(e: unknown): string {
  // SDK errors first: their numeric `code` is a JSON-RPC / HTTP status, not a socket error code.
  if (e instanceof StreamableHTTPError) return `HTTP ${e.code ?? 'error'}`;
  if (e instanceof McpError) return `MCP error ${e.code}`;
  const err = e as { code?: string; cause?: { code?: string }; message?: string };
  const code = err.cause?.code ?? err.code;
  if (code) return String(code);
  return (err.message ?? 'unknown error').replace(/https?:\/\/\S+/g, '<url>').slice(0, 120);
}
