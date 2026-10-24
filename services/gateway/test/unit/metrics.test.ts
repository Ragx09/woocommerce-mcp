// BON-03: Prometheus exposition of /mcp activity (TC-BON-03-1).
import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../src/audit/audit.js';
import { buildMetricsServer, Metrics } from '../../src/metrics.js';

const ev = (over: Partial<AuditEvent>): AuditEvent => ({ requestId: 'r', userId: 'u', apiKeyId: null, source: 'mcp', method: 'tools/call',
  upstreamId: 'id-woo', upstreamSlug: 'woo', tool: 'list_orders', durationMs: 120, outcome: 'ok', errorCode: null, ...over });

describe('metrics (BON-03)', () => {
  it('TC-BON-03-1: calls per upstream/outcome/source, latency histogram, lists, denials, gauges', () => {
    const m = new Metrics();
    m.record(ev({}));
    m.record(ev({ durationMs: 15_000, outcome: 'timeout', errorCode: 'upstream_timeout' }));
    m.record(ev({ source: 'chat', durationMs: 40 }));
    // A name the registry did not know never becomes a label value.
    m.record(ev({ upstreamId: null, upstreamSlug: 'attacker-chosen', outcome: 'rejected', errorCode: 'unknown_tool' }));
    m.record(ev({ method: 'tools/list', upstreamId: null, upstreamSlug: null, tool: null }));
    m.record(ev({ outcome: 'denied', userId: null, method: 'other', upstreamId: null, upstreamSlug: null, errorCode: 'invalid_api_key' }));
    m.addGauge({ name: 'mcp_upstream_up', help: 'h', read: () => [{ labels: { upstream: 'woo', status: 'connected' }, value: 1 }] });
    const text = m.render();

    expect(text).toContain('# TYPE mcp_tool_calls_total counter');
    expect(text).toContain('mcp_tool_calls_total{upstream="woo",outcome="ok",source="mcp"} 1');
    expect(text).toContain('mcp_tool_calls_total{upstream="woo",outcome="timeout",source="mcp"} 1');
    expect(text).toContain('mcp_tool_calls_total{upstream="woo",outcome="ok",source="chat"} 1');
    expect(text).toContain('mcp_tool_calls_total{upstream="unknown",outcome="rejected",source="mcp"} 1');
    expect(text).not.toContain('attacker-chosen');
    expect(text).toContain('mcp_tool_call_duration_seconds_bucket{upstream="woo",le="0.05"} 1');
    expect(text).toContain('mcp_tool_call_duration_seconds_bucket{upstream="woo",le="0.25"} 2');
    expect(text).toContain('mcp_tool_call_duration_seconds_bucket{upstream="woo",le="10"} 2');
    expect(text).toContain('mcp_tool_call_duration_seconds_bucket{upstream="woo",le="15"} 3');
    expect(text).toContain('mcp_tool_call_duration_seconds_bucket{upstream="woo",le="+Inf"} 3');
    expect(text).toContain('mcp_tool_call_duration_seconds_count{upstream="woo"} 3');
    expect(Number(/mcp_tool_call_duration_seconds_sum\{upstream="woo"\} (\S+)/.exec(text)?.[1])).toBeCloseTo(15.16, 6);
    expect(text).toContain('mcp_tools_list_total{outcome="ok"} 1');
    expect(text).toContain('mcp_requests_denied_total{reason="invalid_api_key"} 1');
    expect(text).toContain('mcp_upstream_up{upstream="woo",status="connected"} 1');
    // No user ids, tool names or request ids in any series.
    expect(text).not.toMatch(/list_orders|userId|"u"/);
  });

  it('TC-BON-03-1b: label values are escaped', () => {
    const m = new Metrics();
    m.addGauge({ name: 'g', help: 'h', read: () => [{ labels: { upstream: 'a"b\\c\nd' }, value: 0 }] });
    expect(m.render()).toContain('g{upstream="a\\"b\\\\c\\nd"} 0');
  });

  it('TC-BON-03-1c: the metrics listener serves /metrics and nothing else', async () => {
    const app = buildMetricsServer(new Metrics());
    const ok = await app.inject({ method: 'GET', url: '/metrics' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toMatch(/^text\/plain; version=0\.0\.4/);
    for (const url of ['/mcp', '/api/upstreams', '/healthz']) expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    await app.close();
  });
});
