// SEC-04/05 extension for the multi-store and hosted-server surface (BON-09..15): authorization matrix, IDOR, CSRF, injection,
// mass assignment, one-time secrets, signed internal routes, store tool access. Live: a cluster (default) or a gateway started by
// hand (see lib.mjs, SEC_* variables). Creates at most TWO real stores (one for B, one for a throwaway member C) and deletes them; hosted
// servers are only attacked with requests that must be refused, so nothing is created. SEC_ALLOW_BULK=1 adds a cap race (creates up to
// the member cap). Env: READY_TIMEOUT_S (720), SEC_STORE_TOOLS=0 to skip the /mcp checks when the store's upstream cannot be reached.
import { createHmac, createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP, api, demoUsers, extraMember, mcp, rand, tempKey, ZERO_ID } from './lib.mjs';

let a, b, c;
let storeB; let storeC;
const keys = [];
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const READY_MS = Number(process.env.READY_TIMEOUT_S ?? 720) * 1000;
const idem = () => `sec-${rand(8)}`;
const newStore = (cookie, name, extra = {}) => api('POST', '/api/stores', { cookie, headers: { 'idempotency-key': idem() }, body: { name, niche: 'tea-coffee', ...extra } });
async function waitReady(cookie, id) {
  for (const end = Date.now() + READY_MS; Date.now() < end;) {
    const s = (await api('GET', `/api/stores/${id}`, { cookie })).body;
    if (s?.status === 'ready' || s?.status === 'failed') return s;
    await nap(4000);
  }
  throw new Error('store did not become ready');
}

beforeAll(async () => {
  ({ a, b } = await demoUsers());
  c = await extraMember(a.cookie, 'secc');
  const sb = await newStore(b.cookie, `Sec B ${rand(3)}`);
  const sc = await newStore(c.cookie, `Sec C ${rand(3)}`);
  expect([sb.status, sc.status]).toEqual([202, 202]);
  storeB = sb.body; storeC = sc.body;
  await Promise.all([waitReady(b.cookie, storeB.id), waitReady(c.cookie, storeC.id)]);
}, READY_MS + 60_000);

afterAll(async () => {
  for (const s of [storeB, storeC]) if (s) await api('DELETE', `/api/stores/${s.id}?confirm=${s.slug}`, { cookie: s === storeB ? b.cookie : c.cookie }).catch(() => {});
  for (const k of keys) await k.revoke().catch(() => {});
  await c?.disable().catch(() => {});
}, 60_000);

describe('TC-SEC-11-1 authorization matrix (stores and hosted)', () => {
  const adminOnly = () => [
    ['GET', '/api/hosted'], ['POST', '/api/hosted', { name: 'x', slug: 'secx', image: 'ghcr.io/acme/x:1', port: 80 }], ['GET', `/api/hosted/${ZERO_ID}`], ['DELETE', `/api/hosted/${ZERO_ID}?confirm=x`],
    ['POST', `/api/stores/${storeB.id}/admin-password/reset`],
  ];
  it('hosted routes and the password reset: anonymous 401, member 403 (also for the store\'s own owner)', async () => {
    for (const [m, p, body] of adminOnly()) {
      const mem = await api(m, p, { cookie: b.cookie, body, headers: m === 'POST' ? { 'idempotency-key': idem() } : {} });
      const anon = await api(m, p, { body });
      expect.soft([mem.status, anon.status], `${m} ${p}`).toEqual([403, 401]);
    }
  });
  it('every store route needs a session', async () => {
    const calls = [['GET', '/api/stores'], ['GET', '/api/stores/slug?name=x'], ['POST', '/api/stores', { name: 'x', niche: 'bags' }], ['GET', `/api/stores/${storeB.id}`], ['DELETE', `/api/stores/${storeB.id}?confirm=${storeB.slug}`],
      ['PATCH', `/api/stores/${storeB.id}`, { memberAccess: 'all' }], ['POST', `/api/stores/${storeB.id}/members`, { email: 'x@example.invalid' }], ['DELETE', `/api/stores/${storeB.id}/members/${ZERO_ID}`], ['POST', `/api/stores/${storeB.id}/admin-password`]];
    for (const [m, p, body] of calls) expect.soft((await api(m, p, { body })).status, `${m} ${p}`).toBe(401);
  });
  it('IDOR: another member gets the same 404 for a real foreign store as for a random id (no hint it exists), on every route', async () => {
    const probe = async (id) => {
      const r = [];
      for (const [m, p, body] of [['GET', `/api/stores/${id}`], ['DELETE', `/api/stores/${id}?confirm=x`], ['PATCH', `/api/stores/${id}`, { memberAccess: 'all' }], ['POST', `/api/stores/${id}/members`, { email: 'x@example.invalid' }],
        ['DELETE', `/api/stores/${id}/members/${ZERO_ID}`], ['POST', `/api/stores/${id}/admin-password`]]) {
        const res = await api(m, p, { cookie: c.cookie, body, headers: {} });
        r.push([res.status, res.body?.error]);
      }
      return r;
    };
    const foreign = await probe(storeB.id);
    const random = await probe(randomUUID());
    expect(foreign).toEqual(random);
    expect(foreign.every(([s]) => s === 404)).toBe(true);
    const list = (await api('GET', '/api/stores', { cookie: c.cookie })).body.stores.map((s) => s.slug);
    expect(list).not.toContain(storeB.slug);
  });
  it('the owner may view and manage, but an owner who is not an admin cannot see admin-only detail', async () => {
    const own = (await api('GET', `/api/stores/${storeB.id}`, { cookie: b.cookie })).body;
    expect(own).toMatchObject({ role: 'owner', canManage: true });
    for (const k of ['namespace', 'runtime', 'passwordReset', 'desired']) expect(own, k).not.toHaveProperty(k);
    const adm = (await api('GET', `/api/stores/${storeB.id}`, { cookie: a.cookie })).body;
    expect(adm).toHaveProperty('namespace');
  });
  it('a shared member sees less and manages nothing; a member cannot add an admin or the owner, or share with an invented address', async () => {
    const share = await api('POST', `/api/stores/${storeB.id}/members`, { cookie: b.cookie, body: { email: c.email } });
    expect(share.status).toBe(201);
    const seen = (await api('GET', `/api/stores/${storeB.id}`, { cookie: c.cookie })).body;
    expect(seen).toMatchObject({ role: 'shared', canManage: false });
    for (const k of ['members', 'toolRule', 'passwordAvailable', 'adminUrl']) expect(seen, k).not.toHaveProperty(k);
    for (const [m, p, body] of [['PATCH', `/api/stores/${storeB.id}`, { memberAccess: 'all' }], ['POST', `/api/stores/${storeB.id}/members`, { email: a.email ?? 'x@example.invalid' }], ['POST', `/api/stores/${storeB.id}/admin-password`], ['DELETE', `/api/stores/${storeB.id}?confirm=${storeB.slug}`]]) {
      expect.soft((await api(m, p, { cookie: c.cookie, body })).status, `${m} ${p} as shared member`).toBe(403);
    }
    expect((await api('POST', `/api/stores/${storeB.id}/members`, { cookie: b.cookie, body: { email: a.user.email } })).status).toBe(409); // admins already have access
    expect((await api('POST', `/api/stores/${storeB.id}/members`, { cookie: b.cookie, body: { email: 'nobody-' + rand(4) + '@example.invalid' } })).status).toBe(404);
    expect((await api('DELETE', `/api/stores/${storeB.id}/members/${c.user.id}`, { cookie: c.cookie })).status).toBe(204); // a member may leave
  });
});

describe('TC-SEC-11-2 CSRF and origin on the new mutations', () => {
  it('a cookie-carrying mutation from another origin, or with no browser header at all, is refused', async () => {
    const attempts = [['POST', '/api/stores', { name: 'Csrf Shop', niche: 'bags' }], ['DELETE', `/api/stores/${storeB.id}?confirm=${storeB.slug}`], ['POST', `/api/stores/${storeB.id}/admin-password`],
      ['POST', `/api/stores/${storeB.id}/members`, { email: c.email }], ['PATCH', `/api/stores/${storeB.id}`, { memberAccess: 'all' }]];
    for (const [m, p, body] of attempts) {
      const foreign = await api(m, p, { cookie: b.cookie, body, origin: 'https://evil.example', headers: { 'idempotency-key': idem() } });
      const none = await api(m, p, { cookie: b.cookie, body, origin: false, headers: { 'idempotency-key': idem() } });
      expect.soft([foreign.status, none.status], `${m} ${p}`).toEqual([403, 403]);
    }
    const still = (await api('GET', `/api/stores/${storeB.id}`, { cookie: b.cookie })).body;
    expect(still.status).toBe('ready'); // nothing was deleted, no password consumed
    expect(still.passwordAvailable).toBe(true);
  });
});

describe('TC-SEC-11-3 injection and mass assignment', () => {
  const payloads = ["'; DROP TABLE stores; --", '{{ .Values.global }}', '{{7*7}}', '$(id)', '`id`', 'a\nb: c', '<img src=x onerror=alert(1)>', '"; rm -rf / #', '../../etc/passwd', '\u0000', '%s%s%s', '${HOME}', 'x'.repeat(200), '--set init.title=pwn', '- yaml: list', 'a: b'];
  it('names and the custom niche text with metacharacters are refused; the tagline may hold plain punctuation only, and is stored literally', async () => {
    const TAGLINE_OK = /^[\p{L}\p{N} .,'&!?:;()-]*$/u;
    const accepted = [];
    for (const p of payloads) {
      for (const [field, body] of [['name', { name: p, niche: 'bags' }], ['tagline', { name: 'Inj Shop', niche: 'bags', tagline: p }], ['nicheText', { name: 'Inj Shop', niche: 'custom', nicheText: p }]]) {
        const r = await newStore(b.cookie, body.name, { niche: body.niche, ...(body.tagline ? { tagline: body.tagline } : {}), ...(body.nicheText ? { nicheText: body.nicheText } : {}) });
        if (r.status === 202) {
          accepted.push([field, p, r.body.tagline]);
          await api('DELETE', `/api/stores/${r.body.id}?confirm=${r.body.slug}`, { cookie: b.cookie });
        } else expect.soft([400, 409], `${field} ${JSON.stringify(p).slice(0, 30)} → ${r.status}`).toContain(r.status);
      }
    }
    // Only taglines made of plain punctuation may be accepted (rendered by Helm with `quote`, by WordPress with escaping), and they round-trip literally.
    for (const [field, p, stored] of accepted) {
      expect.soft(field, `${JSON.stringify(p)} accepted as ${field}`).toBe('tagline');
      expect.soft(TAGLINE_OK.test(p), JSON.stringify(p)).toBe(true);
      expect.soft(stored).toBe(p.trim().replace(/\s+/g, ' '));
    }
    // The SQL-looking tagline did not hurt anything: the stores table is intact and listable.
    expect((await api('GET', '/api/stores', { cookie: b.cookie })).status).toBe(200);
  });
  it('path, query and id parameters: SQL/NoSQL-looking values give 400/404, never a 5xx or a data leak', async () => {
    const calls = [['GET', `/api/stores/slug?name=${encodeURIComponent("x' OR '1'='1")}`], ['GET', '/api/stores/slug'], ['GET', '/api/stores/not-a-uuid'], ['GET', `/api/stores/${storeB.id}%27`], ['DELETE', `/api/stores/${storeB.id}?confirm[]=a&confirm=b`],
      ['GET', `/api/stores/${storeB.id}/../${storeC.id}`], ['DELETE', `/api/stores/${storeB.id}/members/1%20OR%201=1`]];
    for (const [m, p] of calls) {
      const r = await api(m, p, { cookie: b.cookie });
      expect.soft(r.status, `${m} ${p}`).toBeLessThan(500);
      expect.soft(r.text, `${m} ${p}`).not.toMatch(/syntax error|pg_|postgres|stack|at .*\.js/i);
    }
    const foreignViaTraversal = await api('GET', `/api/stores/${storeB.id}/../${storeC.id}`, { cookie: b.cookie });
    expect(foreignViaTraversal.body?.slug ?? null).not.toBe(storeC.slug);
  });
  it('slugs are ASCII, and look-alike names cannot take over another store\'s address name', async () => {
    const prev = (n) => api('GET', `/api/stores/slug?name=${encodeURIComponent(n)}`, { cookie: b.cookie }).then((r) => r.body);
    const real = await prev(storeB.name);
    expect(real.available).toBe(false); // exact name is taken
    for (const n of [storeB.name.toUpperCase(), storeB.name.replace(/a/g, 'а'), `Ｓｅｃ Ｂ ${storeB.slug.slice(-3)}`, ` ${storeB.name} `]) {
      const r = await prev(n);
      expect.soft(r.slug, n).toMatch(/^[a-z0-9-]*$/);
      if (r.slug === storeB.slug) expect.soft(r.available, `${n} must not be available`).toBe(false);
    }
  });
  it('mass assignment: ownership, status, slug and server-side fields in create/patch/share bodies are refused', async () => {
    const extra = [{ ownerId: c.user.id }, { status: 'ready' }, { desired: 'absent' }, { slug: 'taken-over' }, { adminPasswordEnc: {} }, { id: randomUUID() }];
    for (const e of extra) expect.soft((await newStore(b.cookie, 'Mass Shop', { niche: 'bags', ...e })).status, JSON.stringify(e)).toBe(400);
    for (const e of [{ memberAccess: 'all', ownerId: c.user.id }, { memberAccess: 'all', status: 'failed' }, { memberAccess: 'selected', memberTools: ['drop_database'] }, { memberAccess: 'selected', memberTools: ['__proto__'] }]) {
      expect.soft((await api('PATCH', `/api/stores/${storeB.id}`, { cookie: b.cookie, body: e })).status, JSON.stringify(e)).toBe(400);
    }
    expect.soft((await api('POST', `/api/stores/${storeB.id}/members`, { cookie: b.cookie, body: { email: c.email, role: 'admin' } })).status).toBe(400);
    expect((await api('GET', `/api/stores/${storeB.id}`, { cookie: b.cookie })).body.owner.id).toBe(b.user.id);
  });
  it('the Idempotency-Key cannot be used to read or hijack another person\'s store', async () => {
    const key = idem();
    const mine = await api('POST', '/api/stores', { cookie: b.cookie, headers: { 'idempotency-key': key }, body: { name: storeB.name, niche: 'tea-coffee' } });
    expect([200, 409]).toContain(mine.status); // same key + same store (or the name is taken): never a new store
    const theirs = await api('POST', '/api/stores', { cookie: c.cookie, headers: { 'idempotency-key': key }, body: { name: `Key Probe ${rand(3)}`, niche: 'bags' } });
    if (theirs.status === 202) await api('DELETE', `/api/stores/${theirs.body.id}?confirm=${theirs.body.slug}`, { cookie: c.cookie });
    expect(theirs.body?.id ?? null).not.toBe(storeB.id); // keys are per owner: C's identical key never returns B's store
    expect((await api('POST', '/api/stores', { cookie: c.cookie, body: { name: 'No Key', niche: 'bags' } })).status).toBe(400);
  });
});

describe('TC-SEC-11-4 one-time secrets', () => {
  it('the wp-admin password is handed out once, even to ten racing requests; not to anyone else; not through any other response', async () => {
    const shots = await Promise.all(Array.from({ length: 10 }, () => api('POST', `/api/stores/${storeC.id}/admin-password`, { cookie: c.cookie })));
    const ok = shots.filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    const pw = ok[0].body.password;
    expect(pw.length).toBeGreaterThanOrEqual(16);
    expect(shots.filter((r) => r.status === 410)).toHaveLength(9);
    expect(ok[0].headers.get('cache-control')).toBe('no-store');
    // Nowhere else: not in any store/upstream/hosted response of any role, not for the admin, not in the list.
    for (const cookie of [a.cookie, b.cookie, c.cookie]) {
      for (const path of ['/api/stores', `/api/stores/${storeC.id}`, '/api/upstreams', '/api/hosted', '/api/audit?limit=200']) {
        const r = await api('GET', path, { cookie });
        expect.soft(r.text.includes(pw), `${path} leaks the password`).toBe(false);
      }
    }
    expect((await api('POST', `/api/stores/${storeC.id}/admin-password`, { cookie: a.cookie })).status).toBe(410); // admins do not get a second look either
    expect((await api('POST', `/api/stores/${storeC.id}/admin-password`, { cookie: b.cookie })).status).toBe(404);
  });
  it('no response of the new routes contains a credential-shaped string (WooCommerce keys, tokens, hashes, sealed blobs)', async () => {
    const bad = /ck_[0-9a-f]{20}|cs_[0-9a-f]{20}|"credentialEnc"|"adminPasswordEnc"|"passwordResetEnc"|"secretEnvEnc"|ciphertext|"iv":|gh[pous]_[A-Za-z0-9]{20}|mgw_[0-9A-Za-z]{40}|\$argon2/;
    for (const [cookie, who] of [[a.cookie, 'admin'], [b.cookie, 'owner'], [c.cookie, 'other']]) {
      for (const path of ['/api/stores', `/api/stores/${storeB.id}`, `/api/stores/${storeC.id}`, '/api/upstreams', '/api/hosted', '/api/me']) {
        const r = await api('GET', path, { cookie });
        if (r.status === 200) expect.soft(r.text, `${who} ${path}`).not.toMatch(bad);
      }
    }
  });
});

describe('TC-SEC-11-5 hosted servers: everything dangerous is refused and nothing is created', () => {
  const REG = async () => (await api('GET', '/api/hosted', { cookie: a.cookie })).body;
  it('bad images, registries, tags, env names and values are all refused', async () => {
    const before = await REG();
    const ok = before.registries[0] ?? 'ghcr.io/ragx09';
    const base = { name: 'Sec Hosted', slug: `sech${rand(2)}`, port: 8080 };
    const existing = ((await api('GET', '/api/upstreams', { cookie: a.cookie })).body ?? []).find((u) => /^[a-z][a-z0-9-]{1,14}[a-z0-9]$/.test(u.slug))?.slug; // a slug an upstream already has: must clash
    const attempts = [
      { image: 'docker.io/library/nginx:1.27' }, { image: 'evil.example/x/y:1' }, { image: `${ok}/tool:latest` }, { image: `${ok}/tool` }, { image: `${ok}evil/tool:1` }, { image: `${ok}/../../evil:1` },
      { image: `${ok}/tool:1 --privileged` }, { image: `${ok}/tool:1;rm -rf /` }, { image: `${ok}/tool:1\n--network=host` }, { image: `${ok}/tool@sha256:abc` }, { image: `http://${ok}/tool:1` }, { image: 'nginx' },
      { image: `${ok}/tool:1`, env: { LD_PRELOAD: '/tmp/x.so' } }, { image: `${ok}/tool:1`, env: { KUBERNETES_SERVICE_HOST: '1.2.3.4' } }, { image: `${ok}/tool:1`, env: { 'A B': 'x' } }, { image: `${ok}/tool:1`, env: { 'A=B': 'x' } },
      { image: `${ok}/tool:1`, env: { A: 'x\ny' } }, { image: `${ok}/tool:1`, env: { A: '$(id)'.repeat(2000) } }, { image: `${ok}/tool:1`, env: { PATH: '/tmp' } },
      { image: `${ok}/tool:1`, secretEnv: { LD_LIBRARY_PATH: '/x' } }, { image: `${ok}/tool:1`, port: 0 }, { image: `${ok}/tool:1`, port: 99999 }, { image: `${ok}/tool:1`, path: '/../../etc' }, { image: `${ok}/tool:1`, path: '/mcp/..' }, { image: `${ok}/tool:1`, path: '/a//b' }, { image: `${ok}/tool:1`, path: 'mcp' },
      ...(existing ? [{ image: `${ok}/tool:1`, slug: existing }] : []), { image: `${ok}/tool:1`, slug: 'default' }, { image: `${ok}/tool:1`, slug: 'A--b' }, { image: `${ok}/tool:1`, privileged: true }, { image: `${ok}/tool:1`, hostNetwork: true }, { image: `${ok}/tool:1`, command: ['sh'] },
    ];
    for (const e of attempts) {
      const r = await api('POST', '/api/hosted', { cookie: a.cookie, body: { ...base, ...e } });
      expect.soft(r.status, JSON.stringify(e).slice(0, 90)).toBeGreaterThanOrEqual(400);
      expect.soft(r.status, JSON.stringify(e).slice(0, 90)).toBeLessThan(500);
    }
    const after = await REG();
    expect(after.servers.length).toBe(before.servers.length); // nothing was created
  });
  it('cross-origin and header-less cookie mutations on /api/hosted are refused', async () => {
    const body = { name: 'Csrf', slug: 'csrfh', image: 'ghcr.io/ragx09/x:1', port: 80 };
    expect((await api('POST', '/api/hosted', { cookie: a.cookie, body, origin: 'https://evil.example' })).status).toBe(403);
    expect((await api('POST', '/api/hosted', { cookie: a.cookie, body, origin: false })).status).toBe(403);
  });
});

describe('TC-SEC-11-6 the internal provisioner API cannot be driven from outside', () => {
  const sig = (key, path, body, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', key).update(`${t}\nPOST\n${path}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex')}`;
  it('unsigned, wrongly signed and stale calls never succeed (via the public URL they do not even reach the gateway)', async () => {
    const targets = [`/internal/stores/${storeB.id}/ready`, `/internal/stores/${storeB.id}/missing`, `/internal/stores/${storeB.id}/password-reset`, `/internal/stores/${storeB.id}/runtime`, `/internal/stores/${storeB.id}/deleted`, `/internal/hosted/${ZERO_ID}/ready`];
    for (const path of targets) {
      const body = JSON.stringify({ ok: true, url: 'http://evil.example/mcp', pods: { ready: 1, total: 1 } });
      const variants = [{}, { 'x-platform-signature': sig(randomUUID(), path, body) }, { 'x-platform-signature': sig(randomUUID(), path, body, Math.floor(Date.now() / 1000) - 3600) }, { 'x-platform-signature': 't=1,v1=' + '0'.repeat(64) }, { 'x-platform-signature': 'garbage' }];
      for (const headers of variants) {
        const res = await fetch(`${APP}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
        expect.soft(res.status === 401 || res.status === 404 || res.status === 405 || res.status === 403, `${path} ${Object.keys(headers)[0] ?? 'unsigned'} → ${res.status}`).toBe(true);
      }
    }
    const s = (await api('GET', `/api/stores/${storeB.id}`, { cookie: b.cookie })).body;
    expect([s.status, s.statusReason]).toEqual(['ready', null]); // none of the forged calls changed the store
  });
});

describe('TC-SEC-11-7 a store\'s tools: owner, shared member, everyone else', () => {
  const skip = process.env.SEC_STORE_TOOLS === '0';
  it.skipIf(skip)('B sees and may call its own store\'s tools; C sees none of them and is refused by name; admins see all', async () => {
    const kb = await tempKey(b.cookie); const kc = await tempKey(c.cookie); const ka = await tempKey(a.cookie); keys.push(kb, kc, ka);
    const names = async (k) => ((await mcp(k.key, 'tools/list')).body?.result?.tools ?? []).map((t) => t.name);
    // The store's server may need a moment after Ready for its first discovery.
    let nb = [];
    for (let i = 0; i < 12 && nb.length === 0; i++) { nb = await names(kb); if (!nb.length) await nap(5000); }
    expect(nb.some((n) => n.startsWith(`woo-${storeB.slug}__`))).toBe(true);
    expect(nb.some((n) => n.startsWith(`woo-${storeC.slug}__`))).toBe(false);
    const nc = await names(kc);
    expect(nc.some((n) => n.startsWith(`woo-${storeB.slug}__`))).toBe(false);
    const na = await names(ka);
    expect(na.some((n) => n.startsWith(`woo-${storeB.slug}__`)) && na.some((n) => n.startsWith(`woo-${storeC.slug}__`))).toBe(true);
    for (const tool of ['list_orders', 'create_product', 'update_order_status', 'update_product']) {
      const r = await mcp(kc.key, 'tools/call', { name: `woo-${storeB.slug}__${tool}`, arguments: {} });
      expect.soft(r.body?.error?.data?.code, tool).toBe('tool_forbidden');
    }
    // The member rule is the owner's to widen and nobody else's.
    const mine = await api('PATCH', `/api/stores/${storeB.id}`, { cookie: c.cookie, body: { memberAccess: 'all' } });
    expect(mine.status).toBe(404);
  }, 180_000);
});

describe.skipIf(!process.env.SEC_ALLOW_BULK)('TC-SEC-11-8 cap race (SEC_ALLOW_BULK=1)', () => {
  it('parallel creates by one member never exceed the cap', async () => {
    const cap = (await api('GET', '/api/stores', { cookie: c.cookie })).body.limits;
    const res = await Promise.all(Array.from({ length: cap.maxPerMember + 3 }, (_, i) => newStore(c.cookie, `Race ${rand(3)}${i}`)));
    const made = res.filter((r) => r.status === 202);
    const mine = (await api('GET', '/api/stores', { cookie: c.cookie })).body.stores.filter((s) => s.role === 'owner').length;
    expect(mine).toBeLessThanOrEqual(cap.maxPerMember);
    for (const r of made) await api('DELETE', `/api/stores/${r.body.id}?confirm=${r.body.slug}`, { cookie: c.cookie });
  }, 120_000);
});
