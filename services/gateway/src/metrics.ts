// BON-03 (REQ-SO-08): Prometheus metrics for this replica, served on a separate internal port
// (METRICS_PORT, not routed by the Ingress; NetworkPolicy lets only labelled scrapers in).
// Fed by the same events as the audit log (audit.ts), so every /mcp request is counted exactly once.
// Labels are bounded on purpose: the upstream slug only when the registry knew it (else "unknown",
// a client-supplied name never becomes a label), no tool names, users or arguments.
// Written by hand (text exposition format 0.0.4) instead of adding a client library: three metric types.
import Fastify, { type FastifyInstance } from 'fastify';
import type { AuditEvent } from './audit/audit.js';

/** Seconds; one call budget is 15 s (MCP_DESIGN §6), so the top bucket below +Inf catches timeouts. */
const BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30];

type Labels = Record<string, string>;
const key = (l: Labels) => JSON.stringify(Object.entries(l).sort(([a], [b]) => a.localeCompare(b)));
const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const fmt = (l: Labels) => {
  const parts = Object.entries(l).map(([k, v]) => `${k}="${esc(v)}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
};

class Counter {
  readonly #values = new Map<string, { labels: Labels; value: number }>();
  constructor(readonly name: string, readonly help: string) {}
  inc(labels: Labels, by = 1): void {
    const k = key(labels);
    const cur = this.#values.get(k);
    if (cur) cur.value += by; else this.#values.set(k, { labels, value: by });
  }
  get(labels: Labels): number { return this.#values.get(key(labels))?.value ?? 0; }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.#values.values()) lines.push(`${this.name}${fmt(labels)} ${value}`);
    return lines.join('\n');
  }
}

class Histogram {
  readonly #series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
  constructor(readonly name: string, readonly help: string) {}
  observe(labels: Labels, seconds: number): void {
    const k = key(labels);
    let s = this.#series.get(k);
    if (!s) { s = { labels, counts: BUCKETS.map(() => 0), sum: 0, count: 0 }; this.#series.set(k, s); }
    BUCKETS.forEach((b, i) => { if (seconds <= b) s!.counts[i]!++; });
    s.sum += seconds;
    s.count++;
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.#series.values()) {
      BUCKETS.forEach((b, i) => lines.push(`${this.name}_bucket${fmt({ ...s.labels, le: String(b) })} ${s.counts[i]}`));
      lines.push(`${this.name}_bucket${fmt({ ...s.labels, le: '+Inf' })} ${s.count}`);
      lines.push(`${this.name}_sum${fmt(s.labels)} ${s.sum}`, `${this.name}_count${fmt(s.labels)} ${s.count}`);
    }
    return lines.join('\n');
  }
}

/** A gauge read at scrape time (e.g. upstream status from the health monitor). */
export interface GaugeSource { name: string; help: string; read: () => { labels: Labels; value: number }[] }

export class Metrics {
  readonly toolCalls = new Counter('mcp_tool_calls_total', 'tools/call requests by upstream, outcome and source.');
  readonly toolCallSeconds = new Histogram('mcp_tool_call_duration_seconds', 'tools/call duration in the gateway by upstream (incl. connect and refusals).');
  readonly toolLists = new Counter('mcp_tools_list_total', 'tools/list requests by outcome.');
  readonly denied = new Counter('mcp_requests_denied_total', 'Requests to /mcp refused before authentication succeeded.');
  readonly #gauges: GaugeSource[] = [];

  addGauge(g: GaugeSource): void { this.#gauges.push(g); }

  /** One audit event = one observation; the same event shape the audit log stores. */
  record(e: AuditEvent): void {
    if (e.outcome === 'denied') { this.denied.inc({ reason: e.errorCode ?? 'denied' }); return; }
    if (e.method === 'tools/list') { this.toolLists.inc({ outcome: e.outcome }); return; }
    if (e.method !== 'tools/call') return;
    const upstream = e.upstreamId && e.upstreamSlug ? e.upstreamSlug : 'unknown';
    this.toolCalls.inc({ upstream, outcome: e.outcome, source: e.source });
    this.toolCallSeconds.observe({ upstream }, e.durationMs / 1000);
  }

  render(): string {
    const out = [this.toolCalls.render(), this.toolCallSeconds.render(), this.toolLists.render(), this.denied.render()];
    for (const g of this.#gauges) {
      const lines = [`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`];
      for (const { labels, value } of g.read()) lines.push(`${g.name}${fmt(labels)} ${value}`);
      out.push(lines.join('\n'));
    }
    return `${out.join('\n')}\n`;
  }
}

/** A second listener with only GET /metrics: nothing else of the gateway is reachable on this port. */
export function buildMetricsServer(metrics: Metrics): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get('/metrics', async (_req, reply) => reply.type('text/plain; version=0.0.4; charset=utf-8').send(metrics.render()));
  return app;
}
