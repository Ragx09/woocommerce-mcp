#!/usr/bin/env node
// BON-15 (REQ-BON-08) + TC-BON-13-1 + TC-BON-14-3: the multi-store acceptance test on a running cluster.
//   1. A (admin) creates two stores of different niches through /api/stores (tea & coffee, bike accessories).
//      Twenty seconds in, the provisioner pod is killed (TC-BON-14-3): both stores must still reach Ready.
//   2. B (member) sees neither store and cannot call their tools; the tools appear for A without any manual step
//      (TC-BON-13-1) and a call to each store's `list_orders` works; sharing a store with B gives B the read-only set.
//   3. Orders are placed on each storefront (Cash on delivery): 2 in the first store, 1 in the second.
//   4. The chat compares today's orders across the two stores; each store's call count must equal that store's
//      MariaDB, and the answer must name both counts.
//   5. The second store is deleted: its tools are gone on the next request, /api/upstreams no longer lists it, its
//      namespace, volumes and Helm release are gone, and its audit rows remain. Then the first store is deleted too
//      (KEEP=1 keeps it).
// Needs kubectl access to the cluster (read-only except the provisioner pod kill) and the real LLM (one question,
// retried once on a rate limit). Creates and deletes two stores and three orders.
// Usage: node scripts/e2e-stores.mjs   Env: APP_ORIGIN, STORE_DOMAIN (default store.127.0.0.1.nip.io), KEEP=1,
//        SKIP_KILL=1, SKIP_CHAT=1, KUBECTL_CONTEXT, READY_TIMEOUT_S (default 720)
import { execFileSync } from 'node:child_process';
import { ensureDemoUsers } from './seed-demo-users.mjs';
import { createKey } from './lib/gateway-key.mjs';

const ORIGIN = process.env.APP_ORIGIN ?? 'http://app.127.0.0.1.nip.io';
const DOMAIN = process.env.STORE_DOMAIN ?? 'store.127.0.0.1.nip.io';
const ctx = process.env.KUBECTL_CONTEXT ? ['--context', process.env.KUBECTL_CONTEXT] : [];
const kubectl = (...a) => execFileSync('kubectl', [...ctx, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const kubectlOk = (...a) => { try { return { ok: true, out: kubectl(...a) }; } catch (e) { return { ok: false, out: String(e.stderr ?? e.message) }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = new Date().toISOString().slice(8, 16).replace(/\D/g, ''); // DDHHMM
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` (${extra})` : ''}`); return ok; };

async function api(method, path, cookie, body, headers = {}) {
  const res = await fetch(`${ORIGIN}${path}`, { method, headers: { origin: ORIGIN, cookie, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
}
let rpcId = 0;
async function rpc(key, method, params) {
  const res = await fetch(`${ORIGIN}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) }) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const toolNames = async (key) => ((await rpc(key, 'tools/list')).json?.result?.tools ?? []).map((t) => t.name);
const sql = (slug, q) => kubectl('-n', `store-${slug}`, 'exec', 'mariadb-0', '--', 'sh', '-c', `mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" wordpress -N -e '${q}'`);

const { a, b } = await ensureDemoUsers();
const specs = [
  { name: `E2E Chai ${stamp}`, niche: 'tea-coffee', tagline: 'Small batches' },
  { name: `E2E Ridge ${stamp}`, niche: 'bike', tagline: 'Ride. Drive. Explore.' },
];
let stores = [];
const keepStores = Boolean(process.env.KEEP);

try {
  // 1. Create both at once; kill the provisioner mid-create.
  const t0 = Date.now();
  const made = await Promise.all(specs.map((s, i) => api('POST', '/api/stores', a.cookie, s, { 'idempotency-key': `e2e-${stamp}-${i}-${Date.now()}` })));
  check('TC-BON-15-1a two stores accepted (202, provisioning)', made.every((m) => m.status === 202 && m.body.status === 'provisioning'), made.map((m) => `${m.status} ${m.body?.slug ?? m.body?.message}`).join(', '));
  if (!made.every((m) => m.status === 202)) throw new Error('could not create the stores');
  stores = made.map((m) => m.body);
  const [s1, s2] = stores;
  if (!process.env.SKIP_KILL) {
    await sleep(20_000);
    const before = kubectl('-n', 'platform', 'get', 'pod', '-l', 'app=provisioner', '-o', 'jsonpath={.items[0].metadata.name}');
    kubectl('-n', 'platform', 'delete', 'pod', before, '--wait=false');
    console.log(`  provisioner pod ${before} deleted 20 s into the create`);
  }
  const deadline = Date.now() + Number(process.env.READY_TIMEOUT_S ?? 720) * 1000;
  let states = {};
  while (Date.now() < deadline) {
    states = Object.fromEntries(await Promise.all(stores.map(async (s) => [s.slug, (await api('GET', `/api/stores/${s.id}`, a.cookie)).body])));
    if (Object.values(states).every((s) => s.status === 'ready' || s.status === 'failed')) break;
    await sleep(5_000);
  }
  check('TC-BON-14-3 both stores Ready after the provisioner was killed mid-create', Object.values(states).every((s) => s.status === 'ready'),
    `${Object.values(states).map((s) => `${s.slug}=${s.status}${s.statusReason ? ` (${s.statusReason})` : ''}`).join(' ')} after ${Math.round((Date.now() - t0) / 1000)} s`);
  if (!Object.values(states).every((s) => s.status === 'ready')) throw new Error('stores did not become ready');
  const url = (s) => `http://${s.slug}.${DOMAIN}`;
  const sf = await Promise.all(stores.map((s) => fetch(url(s)).then((r) => r.status)));
  check('TC-BON-11-2 storefronts answer', sf.every((c) => c === 200), sf.join(', '));

  // 2. Access and registration.
  const bList = await api('GET', '/api/stores', b.cookie);
  check('TC-BON-12 member B sees neither store', bList.body.stores.every((s) => s.isDefault), bList.body.stores.map((s) => s.slug).join(','));
  const bKey = await api('POST', '/api/keys', b.cookie, { name: `e2e-stores ${stamp}` });
  const A = await createKey(`e2e-stores ${stamp}`);
  try {
    const aNames = await toolNames(A.key);
    for (const s of stores) check(`TC-BON-13-1 tools of ${s.slug} appear for the owner with no manual step`, ['list_products', 'list_orders', 'get_order', 'create_product', 'update_order_status'].every((t) => aNames.includes(`woo-${s.slug}__${t}`)));
    check('TC-BON-14-4 member B has none of them', !(await toolNames(bKey.body.key)).some((n) => n.startsWith('woo-e2e-')));
    const forbidden = await rpc(bKey.body.key, 'tools/call', { name: `woo-${s1.slug}__list_orders`, arguments: {} });
    check('TC-BON-14-4 B calling a store tool by name is refused', forbidden.json?.error?.data?.code === 'tool_forbidden', JSON.stringify(forbidden.json?.error ?? forbidden.json?.result).slice(0, 100));
    for (const s of stores) {
      const r = await rpc(A.key, 'tools/call', { name: `woo-${s.slug}__list_orders`, arguments: {} });
      check(`TC-BON-13-1 ${s.slug}__list_orders works through the gateway`, r.status === 200 && !r.json?.result?.isError, `${r.status}`);
    }
    const shared = await api('POST', `/api/stores/${s1.id}/members`, a.cookie, { email: b.email });
    check('store shared with B', shared.status === 201);
    const bNames = (await toolNames(bKey.body.key)).filter((n) => n.startsWith('woo-e2e-')).sort();
    check('B gets the read-only set of the shared store only', JSON.stringify(bNames) === JSON.stringify(['list_orders', 'list_products', 'get_order'].map((t) => `woo-${s1.slug}__${t}`).sort()), bNames.join(', '));
    await api('DELETE', `/api/stores/${s1.id}/members/${b.user.id}`, a.cookie);
    check('removing B removes the tools on the next request', !(await toolNames(bKey.body.key)).some((n) => n.startsWith('woo-e2e-')));
  } finally {
    await api('DELETE', `/api/keys/${A.id}`, A.cookie).catch(() => {});
    if (bKey.body?.id) await api('DELETE', `/api/keys/${bKey.body.id}`, b.cookie).catch(() => {});
  }

  // 3. Orders: 2 in the first store, 1 in the second.
  const orderCounts = [2, 1];
  for (const [i, s] of stores.entries()) {
    // Each niche has its own catalogue, so buy something this store actually sells (the checkout default is a TATVA product).
    const products = await fetch(`${url(s)}/wp-json/wc/store/v1/products?per_page=20`).then((r) => r.json()).catch(() => []);
    const product = products.find?.((p) => p.is_purchasable && p.is_in_stock)?.slug ?? '';
    for (let n = 0; n < orderCounts[i]; n++) {
      let out = '';
      try { out = execFileSync('scripts/e2e-checkout.sh', { encoding: 'utf8', env: { ...process.env, STORE_URL: url(s), STORE_NS: `store-${s.slug}`, PRODUCT_SLUG: product } }); }
      catch (e) { out = String(e.stdout ?? '') + String(e.stderr ?? ''); }
      check(`order ${n + 1}/${orderCounts[i]} placed in ${s.slug}`, /order placed: #\d+/.test(out), /order placed: #(\d+)/.exec(out)?.[1] ?? 'failed');
    }
  }
  const dbCount = (s) => Number(sql(s.slug, 'SELECT COUNT(*) FROM wp_posts WHERE post_type="shop_order" AND post_status NOT IN ("trash","auto-draft")'));
  const counts = stores.map(dbCount);
  check('each store database holds exactly its own orders', counts[0] === orderCounts[0] && counts[1] === orderCounts[1], `db ${counts.join(' / ')}`);

  // 4. The chat compares them.
  if (!process.env.SKIP_CHAT) {
    const q = `How many orders came in today in the store "${specs[0].name}" and how many in the store "${specs[1].name}"? Compare the two.`;
    let body = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${ORIGIN}/api/chat`, { method: 'POST', headers: { origin: ORIGIN, cookie: a.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: q }] }) });
      body = await res.json();
      if (res.status === 429 && attempt === 0) { await sleep(Math.min(Number(res.headers.get('retry-after')) || 30, 90) * 1000); continue; }
      if (!res.ok) { check('TC-BON-15-1b chat answered', false, `${body.error}: ${body.message}`); body = null; }
      break;
    }
    if (body) {
      for (const c of body.toolCalls) console.log(`  tool ${c.name} → ${c.ok ? 'ok' : 'error'} ${c.resultPreview.slice(0, 120).replace(/\s+/g, ' ')}`);
      console.log(`  reply: ${body.reply.slice(0, 600)}`);
      for (const [i, s] of stores.entries()) {
        const call = body.toolCalls.find((c) => c.name === `woo-${s.slug}__list_orders` && c.ok);
        let n = null; try { n = JSON.parse(call?.resultPreview ?? '').count; } catch { /* excerpt cut off */ }
        check(`TC-BON-15-1b chat called woo-${s.slug}__list_orders`, Boolean(call));
        if (n !== null) check(`TC-BON-15-1c its count equals ${s.slug}'s database`, n === counts[i], `tool ${n}, db ${counts[i]}`);
      }
      check('TC-BON-15-1d the answer names both counts', new RegExp(`\\b${counts[0]}\\b`).test(body.reply) && new RegExp(`\\b${counts[1]}\\b`).test(body.reply), `${counts.join(' and ')}`);
    }
  }

  // 5. Delete the second store: nothing of it remains.
  const del = await api('DELETE', `/api/stores/${s2.id}?confirm=${s2.slug}`, a.cookie);
  check('TC-BON-15-1e delete accepted', del.status === 202, `${del.status}`);
  const A2 = await createKey(`e2e-stores-2 ${stamp}`);
  try {
    check('its tools are gone on the very next request', !(await toolNames(A2.key)).some((n) => n.startsWith(`woo-${s2.slug}__`)));
    check('/api/upstreams no longer lists it', !(await api('GET', '/api/upstreams', a.cookie)).body.some((u) => u.slug === `woo-${s2.slug}`));
    check('the other store is untouched', (await toolNames(A2.key)).some((n) => n.startsWith(`woo-${s1.slug}__`)));
  } finally { await api('DELETE', `/api/keys/${A2.id}`, A2.cookie).catch(() => {}); }
  const gone = Date.now() + 300_000;
  while (Date.now() < gone && (await api('GET', `/api/stores/${s2.id}`, a.cookie)).status !== 404) await sleep(4_000);
  check('the store disappears from the stores list', (await api('GET', `/api/stores/${s2.id}`, a.cookie)).status === 404);
  check('kubectl: namespace gone', !kubectlOk('get', 'ns', `store-${s2.slug}`).ok);
  const pvs = kubectl('get', 'pv', '-o', 'jsonpath={range .items[*]}{.spec.claimRef.namespace}{"\\n"}{end}').split('\n');
  check('kubectl: no volume left', !pvs.includes(`store-${s2.slug}`));
  check('kubectl: no Helm release left', kubectl('get', 'secret', '-A', '-l', `owner=helm,name=store-${s2.slug}`, '-o', 'name') === '');
  const audit = await api('GET', '/api/audit?limit=200', a.cookie);
  check('audit rows of the deleted store are kept', audit.body.items.some((r) => r.upstream === `woo-${s2.slug}`), 'history outlives the store');
  stores = [s1];
} finally {
  if (!keepStores) {
    for (const s of stores) {
      const r = await api('DELETE', `/api/stores/${s.id}?confirm=${s.slug}`, a.cookie).catch(() => null);
      console.log(`cleanup: delete ${s.slug} → ${r?.status ?? 'error'}`);
    }
  } else console.log(`KEEP=1: stores left in place: ${stores.map((s) => s.slug).join(', ')}`);
}
const failed = results.filter((x) => !x).length;
console.log(failed ? `\nFAIL  BON-15 multi-store acceptance (${failed} of ${results.length})` : `\nPASS  BON-15 multi-store acceptance (${results.length}/${results.length})`);
process.exit(failed ? 1 : 0);
