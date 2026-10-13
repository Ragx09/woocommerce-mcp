// GW-05: tool discovery per upstream with a short-lived cache (docs/MCP_DESIGN.md §4).
// - discover() asks every enabled upstream in parallel for all its tools (following nextCursor),
//   bounded by one deadline per upstream (3 s, including a reconnect).
// - A successful list refreshes the cache. On failure or timeout the last list is served (marked
//   stale) if it is at most 60 s old and the upstream's config has not changed since; otherwise the
//   upstream is reported as failed and left out. One bad upstream never breaks the others.
// - With a HealthMonitor (GW-10): an upstream marked unreachable is not contacted at all (fails fast
//   with its last error, no stale tools), and every live list reports its outcome to the monitor.
// - Concurrent discover() calls share one in-flight list request per upstream.
// - Tools are returned exactly as the upstream sent them; public names and description caps are GW-07.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Upstream } from '../db/schema.js';
import type { HealthMonitor } from './health.js';
import { safeReason, UpstreamTimeoutError, UpstreamUnavailableError, versionOf, withDeadline, type UpstreamPool } from './pool.js';

export { UpstreamTimeoutError };

export interface DiscoveryOptions {
  /** Budget per upstream for the whole list, all pages (docs/MCP_DESIGN.md §6: 3 s). */
  listTimeoutMs?: number;
  /** How old a cached list may be and still be served when the upstream fails. */
  maxStaleMs?: number;
  /** Guard against an upstream that pages forever. */
  maxPages?: number;
  now?: () => number;
  log?: { warn: (obj: object, msg: string) => void };
  health?: Pick<HealthMonitor, 'get' | 'isUnreachable' | 'reportOk' | 'reportFailure'>;
}

export interface UpstreamTools {
  upstream: Upstream;
  tools: Tool[];
  /** Epoch ms when this list was fetched from the upstream. */
  fetchedAt: number;
  /** true: the live request failed and this is the cached list; `error` says why. */
  stale: boolean;
  error?: string;
}

export interface DiscoveryFailure {
  upstream: Upstream;
  /** Safe to show to users: no URLs, no credentials. */
  error: string;
}

export interface DiscoveryResult {
  upstreams: UpstreamTools[];
  failed: DiscoveryFailure[];
}

interface CacheEntry {
  version: string;
  tools: Tool[];
  fetchedAt: number;
}

export class ToolDiscovery {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, { version: string; promise: Promise<CacheEntry> }>();
  private readonly listTimeoutMs: number;
  private readonly maxStaleMs: number;
  private readonly maxPages: number;
  private readonly now: () => number;

  constructor(private readonly pool: UpstreamPool, private readonly opts: DiscoveryOptions = {}) {
    this.listTimeoutMs = opts.listTimeoutMs ?? 3_000;
    this.maxStaleMs = opts.maxStaleMs ?? 60_000;
    this.maxPages = opts.maxPages ?? 20;
    this.now = opts.now ?? Date.now;
  }

  /** Tools of every upstream the pool manages (i.e. enabled ones), in pool order. */
  async discover(): Promise<DiscoveryResult> {
    const rows = this.pool.upstreams();
    const ids = new Set(rows.map((r) => r.id));
    for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id);

    const settled = await Promise.allSettled(rows.map((r) => {
      if (this.opts.health?.isUnreachable(r.id)) {
        return Promise.reject(new MarkedUnreachableError(this.opts.health.get(r).lastError ?? `upstream ${r.slug} unreachable`));
      }
      return this.refresh(r);
    }));
    const result: DiscoveryResult = { upstreams: [], failed: [] };
    settled.forEach((s, i) => {
      const upstream = rows[i]!;
      if (s.status === 'fulfilled') {
        result.upstreams.push({ upstream, tools: s.value.tools, fetchedAt: s.value.fetchedAt, stale: false });
        return;
      }
      const error = errorText(upstream.slug, s.reason);
      const cached = this.cache.get(upstream.id);
      const age = cached ? this.now() - cached.fetchedAt : Infinity;
      const healthy = !this.opts.health?.isUnreachable(upstream.id);
      if (healthy && cached && cached.version === versionOf(upstream) && age <= this.maxStaleMs) {
        this.opts.log?.warn({ upstream: upstream.slug, err: error, ageMs: age }, 'tool discovery failed, serving cached list');
        result.upstreams.push({ upstream, tools: cached.tools, fetchedAt: cached.fetchedAt, stale: true, error });
      } else {
        this.opts.log?.warn({ upstream: upstream.slug, err: error }, 'tool discovery failed, upstream omitted');
        result.failed.push({ upstream, error });
      }
    });
    return result;
  }

  /**
   * Tools of one upstream for routing (GW-08): the cached list when it matches the current config
   * and is at most maxStale old, otherwise a fresh list (shared with any in-flight discovery).
   */
  async toolsFor(row: Upstream): Promise<Tool[]> {
    const cached = this.cache.get(row.id);
    if (cached && cached.version === versionOf(row) && this.now() - cached.fetchedAt <= this.maxStaleMs) return cached.tools;
    return (await this.refresh(row)).tools;
  }

  private refresh(row: Upstream): Promise<CacheEntry> {
    const version = versionOf(row);
    const running = this.inflight.get(row.id);
    if (running?.version === version) return running.promise;
    const promise: Promise<CacheEntry> = this.fetchAll(row)
      .then((tools) => {
        const entry = { version, tools, fetchedAt: this.now() };
        this.cache.set(row.id, entry);
        this.opts.health?.reportOk(row);
        return entry;
      }, (e: unknown) => {
        // Could not connect, or no full list within the budget: the upstream is not usable.
        if (e instanceof UpstreamUnavailableError || e instanceof UpstreamTimeoutError) this.opts.health?.reportFailure(row, e);
        throw e;
      })
      .finally(() => {
        if (this.inflight.get(row.id)?.promise === promise) this.inflight.delete(row.id);
      });
    this.inflight.set(row.id, { version, promise });
    return promise;
  }

  /** All pages, under one deadline that also covers connecting and the pool's single reconnect. */
  private fetchAll(row: Upstream): Promise<Tool[]> {
    return withDeadline(row.slug, this.listTimeoutMs, (signal) => this.pool.withClient(row.id, (c) => this.listAll(c, row.slug, signal)));
  }

  private async listAll(client: Client, slug: string, signal: AbortSignal): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < this.maxPages; page++) {
      const res = await client.listTools(cursor ? { cursor } : undefined, { signal, timeout: this.listTimeoutMs });
      tools.push(...res.tools);
      cursor = res.nextCursor;
      if (!cursor) return tools;
    }
    this.opts.log?.warn({ upstream: slug, pages: this.maxPages, tools: tools.length }, 'tool list truncated: too many pages');
    return tools;
  }
}

/** Not contacted because the health monitor has it as unreachable; the message is its last error. */
class MarkedUnreachableError extends Error {}

function errorText(slug: string, e: unknown): string {
  if (e instanceof UpstreamUnavailableError || e instanceof UpstreamTimeoutError || e instanceof MarkedUnreachableError) return e.message;
  return `upstream ${slug} failed to list tools: ${safeReason(e)}`;
}
