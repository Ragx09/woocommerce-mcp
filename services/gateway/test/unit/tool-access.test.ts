// BON-01: per-role tool permissions — the policy functions and their enforcement in /mcp.
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Principal } from '../../src/auth/api-keys.js';
import type { AuditEvent } from '../../src/audit/audit.js';
import { canCallPublicName, canSeeUpstream, canUseTool } from '../../src/authz/tool-access.js';
import { loadConfig } from '../../src/config.js';
import { loadCredentialKey } from '../../src/crypto/credentials.js';
import type { Upstream } from '../../src/db/schema.js';
import { toPublicName } from '../../src/mcp/naming.js';
import { registerMcp } from '../../src/mcp/route.js';
import { ToolDiscovery } from '../../src/upstreams/discovery.js';
import { UpstreamPool } from '../../src/upstreams/pool.js';
import { startFakeUpstream } from '../helpers/fake-upstream.js';

const key = loadCredentialKey({ CREDENTIALS_KEY: randomBytes(32).toString('hex') });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

const ADMIN_KEY = 'a'.repeat(40);
const MEMBER_KEY = 'm'.repeat(40);
const principals: Record<string, Principal> = {
  [ADMIN_KEY]: { userId: '00000000-0000-4000-8000-00000000000a', keyId: null, role: 'admin', email: 'a@example.test' },
  [MEMBER_KEY]: { userId: '00000000-0000-4000-8000-00000000000b', keyId: null, role: 'member', email: 'b@example.test' },
};

function row(over: Partial<Upstream> & { url: string }): Upstream {
  const now = new Date('2026-10-24T00:00:00Z');
  return { id: 'u1', slug: 'woo', name: 'Woo', enabled: true, authType: 'none', authHeader: null,
    credentialEnc: null, memberAccess: 'all', memberTools: [], storeId: null, createdBy: null, createdAt: now, updatedAt: now, ...over };
}

async function gateway(rows: { current: Upstream[] }, audit: AuditEvent[]) {
  const app = buildApp(loadConfig({ LOG_LEVEL: 'silent' }));
  const pool = new UpstreamPool({ key, connectTimeoutMs: 500 });
  registerMcp(app, {
    authenticate: async (bearer) => principals[bearer] ?? null,
    loadUpstreams: async () => rows.current,
    pool,
    discovery: new ToolDiscovery(pool, { listTimeoutMs: 2_000 }),
    audit: async (e) => { audit.push(e); },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanup.unshift(async () => { await app.close(); await pool.close(); });
  return `http://127.0.0.1:${(app.server.address() as { port: number }).port}/mcp`;
}
async function client(url: string, bearer: string): Promise<Client> {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }));
  cleanup.unshift(() => c.close());
  return c;
}

describe('tool permissions (BON-01)', () => {
  const r = (memberAccess: Upstream['memberAccess'], memberTools: string[] = []) => ({ slug: 'woo', memberAccess, memberTools });

  it('TC-BON-01-U1: admins use everything; members follow memberAccess', () => {
    for (const access of ['all', 'none', 'selected'] as const) {
      expect(canSeeUpstream('admin', r(access))).toBe(true);
      expect(canUseTool('admin', r(access), 'create_product')).toBe(true);
      expect(canCallPublicName('admin', r(access), 'woo__create_product')).toBe(true);
    }
    expect(canSeeUpstream('member', r('none'))).toBe(false);
    expect(canUseTool('member', r('none'), 'list_orders')).toBe(false);
    expect(canUseTool('member', r('all'), 'create_product')).toBe(true);
    const sel = r('selected', ['list_orders', 'odd.tool']);
    expect(canSeeUpstream('member', sel)).toBe(true);
    expect(canUseTool('member', sel, 'list_orders')).toBe(true);
    expect(canUseTool('member', sel, 'create_product')).toBe(false);
    expect(canCallPublicName('member', sel, 'woo__list_orders')).toBe(true);
    expect(canCallPublicName('member', sel, 'woo__create_product')).toBe(false);
    // Shortened/hashed public names are matched exactly, not by prefix or by splitting.
    expect(canCallPublicName('member', sel, toPublicName('woo', 'odd.tool'))).toBe(true);
    expect(canCallPublicName('member', sel, 'woo__odd.tool')).toBe(false);
    expect(canCallPublicName('member', sel, 'woo__list_orders_extra')).toBe(false);
  });

  it('TC-BON-01-U2: tools/list hides denied tools from members only; tools/call refuses them without reaching the upstream', async () => {
    const woo = await startFakeUpstream({ tools: ['list_orders', 'create_product'] });
    const ev = await startFakeUpstream({ tools: ['echo'] });
    cleanup.push(woo.close, ev.close);
    const rows = { current: [
      row({ id: 'w', slug: 'woo', url: woo.url, memberAccess: 'selected', memberTools: ['list_orders'] }),
      row({ id: 'e', slug: 'everything', url: ev.url, memberAccess: 'none' }),
    ] };
    const audit: AuditEvent[] = [];
    const url = await gateway(rows, audit);

    const admin = await client(url, ADMIN_KEY);
    expect((await admin.listTools()).tools.map((t) => t.name)).toEqual(['woo__list_orders', 'woo__create_product', 'everything__echo']);
    expect((await admin.callTool({ name: 'woo__create_product', arguments: {} })).isError).toBeFalsy();

    const member = await client(url, MEMBER_KEY);
    expect((await member.listTools()).tools.map((t) => t.name)).toEqual(['woo__list_orders']);
    expect((await member.callTool({ name: 'woo__list_orders', arguments: {} })).isError).toBeFalsy();
    const before = woo.callCount() + ev.callCount();
    for (const name of ['woo__create_product', 'everything__echo']) {
      await expect(member.callTool({ name, arguments: {} })).rejects.toThrow(/tool not allowed for your role/);
    }
    expect(woo.callCount() + ev.callCount()).toBe(before); // refused before any upstream call
    const refused = audit.filter((e) => e.errorCode === 'tool_forbidden');
    expect(refused.map((e) => [e.userId, e.outcome, e.upstreamSlug])).toEqual([
      [principals[MEMBER_KEY]!.userId, 'rejected', 'woo'], [principals[MEMBER_KEY]!.userId, 'rejected', 'everything']]);

    // A rule change applies on the very next request (rows are read per request, not cached).
    rows.current = [row({ ...rows.current[0]!, memberAccess: 'all' }), rows.current[1]!];
    expect((await member.listTools()).tools.map((t) => t.name)).toEqual(['woo__list_orders', 'woo__create_product']);
    expect((await member.callTool({ name: 'woo__create_product', arguments: {} })).isError).toBeFalsy();
  });

  it('TC-BON-01-U3: a member gets the same refusal for a disabled or unknown-but-forbidden tool (nothing to probe)', async () => {
    const woo = await startFakeUpstream({ tools: ['list_orders'] });
    cleanup.push(woo.close);
    const url = await gateway({ current: [row({ id: 'w', slug: 'woo', url: woo.url, enabled: false, memberAccess: 'selected', memberTools: ['list_orders'] })] }, []);
    const member = await client(url, MEMBER_KEY);
    await expect(member.callTool({ name: 'woo__does_not_exist', arguments: {} })).rejects.toThrow(/tool not allowed for your role/);
    await expect(member.callTool({ name: 'woo__list_orders', arguments: {} })).rejects.toThrow(/disabled/);
  });
});
