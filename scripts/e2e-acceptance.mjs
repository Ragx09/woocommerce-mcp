#!/usr/bin/env node
// Phase 7 acceptance checks (E2E-01, 03, 04, 05, 06, 07, 08, 09, 10) against a running cluster, as the two demo
// users: A = seeded admin (dashboard chat, admin actions), B = member with their own API key (external client).
// Every /mcp request is raw JSON-RPC so its x-request-id is known; the `audit` step then checks that each one is in
// the audit log with the right user, source and outcome (REQ-DOD-11).
//
//   node scripts/e2e-acceptance.mjs url|users|tools|orders|cross|revoke|disable|killpod|all
//   (`audit` runs at the end of every mode, over the requests that mode made)
//
// Side effects: B gets a temporary key per run (revoked at the end; `revoke` revokes it on purpose); `disable`
// disables and re-enables `everything`; `killpod` scales everything-mcp to 0 and back; `disable` asks the chat one
// question (real LLM). `cross` creates a GitHub issue and runs only with GITHUB_REPO=owner/repo (else SKIP).
// Env: APP_ORIGIN (default http://app.127.0.0.1.nip.io), GITHUB_REPO, SKIP_LLM=1, KUBECTL_CONTEXT.
import { execFileSync } from 'node:child_process';
import { ensureDemoUsers } from './seed-demo-users.mjs';

const ORIGIN = process.env.APP_ORIGIN ?? 'http://app.127.0.0.1.nip.io';
const MCP = `${ORIGIN}/mcp`;
const ctx = process.env.KUBECTL_CONTEXT ? ['--context', process.env.KUBECTL_CONTEXT] : [];
const kubectl = (...args) => execFileSync('kubectl', [...ctx, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sql = (q) => kubectl('-n', 'store', 'exec', 'mariadb-0', '--', 'sh', '-c', `mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" wordpress -N -e '${q}'`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` (${extra})` : ''}`); return ok; };
const skip = (name, why) => { results.push({ name, ok: null }); console.log(`SKIP  ${name} (${why})`); };
/** Requests whose audit row the `audit` step must find: { requestId, userId|null, source, outcome, tool }. */
const expected = [];

async function api(method, path, cookie, body) {
  const res = await fetch(`${ORIGIN}${path}`, { method,
    headers: { origin: ORIGIN, cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null), headers: res.headers };
}

let rpcId = 0;
/** One JSON-RPC request to /mcp → { status, requestId, json, ms }. */
async function rpc(key, method, params) {
  const t = Date.now();
  const res = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) }) });
  return { status: res.status, requestId: res.headers.get('x-request-id'), json: await res.json().catch(() => null), ms: Date.now() - t, headers: res.headers };
}
const text = (r) => r.json?.result?.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n') ?? '';
async function listSlugs(key, who) {
  const r = await rpc(key, 'tools/list');
  const counts = {};
  for (const t of r.json?.result?.tools ?? []) { const s = t.name.split('__')[0]; counts[s] = (counts[s] ?? 0) + 1; }
  if (who && r.status === 200) expected.push({ requestId: r.requestId, userId: who, source: 'mcp', outcome: 'ok', method: 'tools/list' });
  return { r, counts, desc: Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ') };
}
async function callTool(key, who, name, args, outcome = 'ok') {
  const r = await rpc(key, 'tools/call', { name, arguments: args });
  if (who) expected.push({ requestId: r.requestId, userId: who, source: 'mcp', outcome, method: 'tools/call', tool: name });
  return r;
}

// ---- users and B's key (E2E-03) ----
const { a, b } = await ensureDemoUsers();
const started = new Date(Date.now() - 1000);
const bKey = await api('POST', '/api/keys', b.cookie, { name: `e2e-acceptance ${started.toISOString().slice(0, 16)}` });
if (bKey.status !== 201) { console.error(`cannot create B's key: ${bKey.status}`); process.exit(1); }
const B = bKey.body.key;
async function upstream(slug) { return (await api('GET', '/api/upstreams', a.cookie)).body.find((u) => u.slug === slug); }
async function setEnabled(slug, enabled) {
  const u = await upstream(slug);
  return api('PATCH', `/api/upstreams/${u.id}`, a.cookie, { enabled });
}

const steps = {
  async users() {
    check('TC-E2E-03-1 user A signs in (admin)', a.user.role === 'admin', a.user.email);
    check('TC-E2E-03-1 user B signs in (member) and has an own key', b.user.role === 'member' && B.startsWith('mgw_'), `${b.email}, key ${bKey.body.prefix}…`);
  },

  async url() { // E2E-01 / TC-K8S-04
    const none = await rpc(null, 'initialize', {});
    expected.push({ requestId: none.requestId, userId: null, source: 'mcp', outcome: 'denied' });
    check('TC-K8S-04a /mcp without a key → 401 + WWW-Authenticate', none.status === 401 && none.headers.get('www-authenticate') === 'Bearer', `${none.status}`);
    const bad = await rpc('mgw_' + 'x'.repeat(43), 'tools/list');
    expected.push({ requestId: bad.requestId, userId: null, source: 'mcp', outcome: 'denied' });
    check('TC-K8S-04b /mcp with a forged key → 401', bad.status === 401, `${bad.status}`);
    const init = await rpc(B, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
    check('TC-K8S-04c initialize with B\'s key → ok', init.status === 200 && Boolean(init.json?.result?.serverInfo), `${init.json?.result?.serverInfo?.name} ${init.json?.result?.protocolVersion}`);
    const get = await fetch(MCP, { headers: { authorization: `Bearer ${B}` } });
    check('TC-K8S-04d GET /mcp → 405', get.status === 405, `${get.status}`);
  },

  async tools() { // E2E-04 / REQ-DOD-06: B sees the tools of every enabled server
    const enabled = (await api('GET', '/api/upstreams', b.cookie)).body.filter((u) => u.enabled !== false && u.status !== 'disabled');
    const { r, counts, desc } = await listSlugs(B, b.user.id);
    check('TC-EXT-01 B tools/list → tools of every enabled server', r.status === 200 && enabled.every((u) => counts[u.slug] > 0),
      `${desc}; enabled: ${enabled.map((u) => u.slug).join(', ')}`);
    try { // the same with the real MCP Inspector CLI (what a reviewer would run)
      const out = execFileSync('npx', ['-y', '@modelcontextprotocol/inspector@2.10.1', '--cli', MCP, '--transport', 'http',
        '--header', `Authorization: Bearer ${B}`, '--method', 'tools/list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
      const names = JSON.parse(out).tools.map((t) => t.name);
      check('TC-EXT-01 MCP Inspector CLI with B\'s key lists woo, everything and github tools',
        ['woo__', 'everything__', 'github__'].every((p) => names.some((n) => n.startsWith(p))), `${names.length} tools`);
    } catch (e) { check('TC-EXT-01 MCP Inspector CLI with B\'s key', false, String(e.stderr ?? e.message).slice(0, 160)); }
  },

  async orders() { // E2E-05 / REQ-DOD-06: B asks today's orders (the MCP call Claude Code makes)
    const tz = sql('SELECT option_value FROM wp_options WHERE option_name="timezone_string"') || 'UTC';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const db = sql(`SELECT ID FROM wp_posts WHERE post_type="shop_order" AND post_status NOT IN ("trash","auto-draft") AND DATE(post_date)="${today}"`)
      .split('\n').filter(Boolean).map(Number).sort((x, y) => x - y);
    const r = await callTool(B, b.user.id, 'woo__list_orders', { date: 'today', per_page: 50 });
    let got = [];
    try { const j = JSON.parse(text(r)); got = (Array.isArray(j) ? j : j.orders ?? []).map((o) => Number(o.id)).sort((x, y) => x - y); } catch { /* checked below */ }
    check('TC-EXT-02 B woo__list_orders {date: today} = the store database', r.status === 200 && !r.json?.result?.isError && got.join() === db.join(),
      `tool [${got.map((i) => `#${i}`).join(', ')}], db [${db.map((i) => `#${i}`).join(', ')}] on ${today} ${tz}`);
  },

  async cross() { // E2E-06 / REQ-DOD-07
    if (!process.env.GITHUB_REPO) return skip('TC-E2E-07 one prompt, two upstreams (woo → github issue)', 'GITHUB_REPO=owner/repo not set (GW-15 blocked)');
    try {
      const out = execFileSync('node', ['scripts/cross-server.mjs'], { encoding: 'utf8', env: { ...process.env, MCP_KEY: B } });
      const url = /issue (https:\S+)/.exec(out)?.[1];
      check('TC-E2E-07 B: woo__list_orders → github__issue_write', Boolean(url), url ?? out.slice(-200));
      expected.push({ userId: b.user.id, source: 'mcp', outcome: 'ok', method: 'tools/call', tool: 'github__issue_write' });
    } catch (e) { check('TC-E2E-07 cross-server', false, String(e.stdout ?? e.message).slice(-200)); }
  },

  async disable() { // E2E-08 / REQ-DOD-09: everything's tools leave B's list and the chat agent's list
    const res = await setEnabled('everything', false);
    try {
      check('TC-E2E-09a admin disables everything', res.status === 200 && res.body.enabled === false, `${res.status}`);
      const { counts, desc } = await listSlugs(B, b.user.id);
      check('TC-E2E-09b B\'s tools/list has no everything tools', !counts.everything && counts.woo > 0 && counts.github > 0, desc);
      const call = await callTool(B, b.user.id, 'everything__echo', { message: 'x' }, 'rejected');
      check('TC-E2E-09c B calling everything__echo → upstream_disabled', /disabled/.test(JSON.stringify(call.json)), JSON.stringify(call.json?.error ?? call.json?.result).slice(0, 100));
      if (process.env.SKIP_LLM) skip('TC-E2E-09d the chat agent has no everything tools', 'SKIP_LLM');
      else {
        const chat = await askChat(a.cookie, 'Use the everything server\'s echo tool to echo the word "hello". If you have no such tool, say so.');
        if (!chat) check('TC-E2E-09d the chat agent has no everything tools', false, 'chat failed');
        else {
          const ev = chat.toolCalls.filter((c) => c.name.startsWith('everything__'));
          check('TC-E2E-09d the chat agent has no everything tools (no everything__ call, reply says so)', ev.length === 0,
            `calls: [${chat.toolCalls.map((c) => c.name).join(', ')}], reply: ${chat.reply.replace(/\s+/g, ' ').slice(0, 120)}`);
        }
      }
    } finally {
      const back = await setEnabled('everything', true);
      check('TC-E2E-09e re-enabled everything', back.status === 200 && back.body.enabled === true);
      await sleep(1500);
      const { counts, desc } = await listSlugs(B, b.user.id);
      check('TC-E2E-09f B sees everything tools again', counts.everything > 0, desc);
    }
  },

  async killpod() { // E2E-09 / REQ-DOD-10
    kubectl('-n', 'platform', 'scale', 'deploy/everything-mcp', '--replicas=0');
    try {
      kubectl('-n', 'platform', 'wait', '--for=delete', 'pod', '-l', 'app=everything-mcp', '--timeout=60s');
      const t = Date.now();
      let st;
      for (let i = 0; i < 30; i++) { st = (await api('GET', '/api/upstreams', b.cookie)).body.find((u) => u.slug === 'everything')?.status; if (st === 'unreachable') break; await sleep(1000); }
      check('TC-E2E-10a dashboard API shows everything Unreachable (as B sees it)', st === 'unreachable', `${st} after ${Math.round((Date.now() - t) / 1000)} s`);
      const { counts, desc } = await listSlugs(B, b.user.id);
      check('TC-E2E-10b B still lists woo and github tools', counts.woo > 0 && counts.github > 0 && !counts.everything, desc);
      const w = await callTool(B, b.user.id, 'woo__list_products', { per_page: 1 });
      check('TC-E2E-10c woo__list_products still works', w.status === 200 && !w.json?.result?.isError, `${w.ms} ms`);
      const g = await callTool(B, b.user.id, 'github__get_me', {});
      check('TC-E2E-10d github__get_me still works', g.status === 200 && !g.json?.result?.isError, `${g.ms} ms`);
      const e = await callTool(B, b.user.id, 'everything__echo', { message: 'x' }, 'unreachable');
      check('TC-E2E-10e everything__echo fails fast', e.ms < 3000 && /unreachable/i.test(JSON.stringify(e.json)), `${e.ms} ms`);
    } finally {
      kubectl('-n', 'platform', 'scale', 'deploy/everything-mcp', '--replicas=1');
      kubectl('-n', 'platform', 'rollout', 'status', 'deploy/everything-mcp', '--timeout=120s');
      let st;
      for (let i = 0; i < 30; i++) { st = (await upstream('everything'))?.status; if (st === 'connected') break; await sleep(1000); }
      check('TC-E2E-10f everything Connected again after scale 1', st === 'connected', st);
    }
  },

  async revoke() { // E2E-07 / REQ-DOD-08 (last: it revokes B's run key)
    const before = await listSlugs(B, b.user.id);
    check('TC-E2E-08a B\'s key works before the revoke', before.r.status === 200, before.desc);
    const del = await api('DELETE', `/api/keys/${bKey.body.id}`, a.cookie);
    check('TC-E2E-08b admin revokes B\'s key', del.status === 204, `${del.status}`);
    const after = await rpc(B, 'tools/list');
    expected.push({ requestId: after.requestId, userId: null, source: 'mcp', outcome: 'denied' });
    check('TC-E2E-08c B\'s next call → 401', after.status === 401, `${after.status} ${JSON.stringify(after.json)}`);
    revoked = true;
  },
};
let revoked = false;

async function askChat(cookie, q) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await api('POST', '/api/chat', cookie, { messages: [{ role: 'user', content: q }] });
    if (res.status === 429 && res.body?.error === 'llm_rate_limited') { await sleep(Math.min(Number(res.headers.get('retry-after')) || 30, 90) * 1000); continue; }
    if (res.status !== 200) { console.log(`chat → ${res.status} ${JSON.stringify(res.body)}`); return null; }
    return res.body;
  }
  return null;
}

// A routed call's row names the upstream tool (`echo`), a refused one the public name (`everything__echo`).
const sameTool = (row, publicName) => row.tool === publicName || `${row.upstream}__${row.tool}` === publicName;

/** E2E-10 / REQ-DOD-11: every request above has its audit row, with the right user and outcome. */
async function audit() {
  const rows = [];
  let cursor;
  do {
    const r = await api('GET', `/api/audit?from=${encodeURIComponent(started.toISOString())}&limit=200${cursor ? `&cursor=${cursor}` : ''}`, a.cookie);
    rows.push(...r.body.items); cursor = r.body.nextCursor;
  } while (cursor);
  const missing = [];
  for (const e of expected) {
    const row = e.requestId ? rows.find((x) => x.requestId === e.requestId)
      : rows.find((x) => sameTool(x, e.tool) && x.user?.id === e.userId);
    const ok = row && (row.user?.id ?? null) === e.userId && row.source === e.source && row.outcome === e.outcome
      && (!e.method || row.method === e.method) && (!e.tool || sameTool(row, e.tool));
    if (!ok) missing.push(`${e.method ?? 'request'} ${e.tool ?? ''} ${e.requestId ?? ''} want ${e.outcome}/${e.userId ?? 'no user'}, got ${row ? `${row.outcome}/${row.user?.id ?? 'no user'}/${row.source}` : 'no row'}`);
  }
  check(`TC-E2E-11 every request of this run is in the audit log with the right user and outcome (${expected.length} requests, ${rows.length} rows since start)`,
    missing.length === 0, missing.slice(0, 3).join('; '));
  const foreign = rows.filter((x) => x.keyPrefix === bKey.body.prefix && x.user && x.user.id !== b.user.id);
  check('TC-E2E-11 no row with B\'s key is attributed to anyone else', foreign.length === 0, `${foreign.length}`);
}

const ORDER = ['users', 'url', 'tools', 'orders', 'cross', 'disable', 'killpod', 'revoke'];
const mode = process.argv[2] ?? '';
const run = mode === 'all' ? ORDER : ORDER.includes(mode) ? [mode] : mode === 'audit' ? ['users', 'tools', 'orders'] : null;
if (!run) { console.error(`usage: e2e-acceptance.mjs ${ORDER.join('|')}|audit|all`); process.exit(2); }
try {
  for (const s of run) { console.log(`\n== ${s}`); await steps[s](); }
  await sleep(500); // audit rows are written after the response
  console.log('\n== audit'); await audit();
} finally {
  if (!revoked) await api('DELETE', `/api/keys/${bKey.body.id}`, a.cookie);
}
const failed = results.filter((r) => r.ok === false).length, skipped = results.filter((r) => r.ok === null).length;
console.log(`\n${failed ? 'FAIL' : 'PASS'}  e2e ${mode}: ${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
