// TC-BON-01-4 (BON-01, REQ-SO-02): an admin restricts members in the dashboard ("Member access" on the
// server form): woo → read tools only, everything → no access. A member's own API key on /mcp then lists
// only those tools and is refused (and audited) on a direct call to create_product; the member's Servers
// page shows the same. The admin's tools are unaffected. Every rule is restored at the end; the throwaway
// member gus-<ts>@example.invalid is disabled and its key revoked.
import { chromium } from 'playwright';

const APP = process.env.APP_URL ?? 'http://app.127.0.0.1.nip.io';
const OUT = '/out';
const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
const READ_TOOLS = ['list_products', 'list_orders', 'get_order'];
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` (${extra})` : ''}`); };

const browser = await chromium.launch();
const errors = [];
async function signIn(email, password, next = '/servers') {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${APP}/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${APP}${next}`);
  return page;
}
const json = (page, method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch(u, { method: m, ...(b ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) } : {}) });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
}, [method, url, body]);
/** One JSON-RPC request to the gateway /mcp with an API key, like any MCP client. */
const rpc = (page, key, method, params = {}) => page.evaluate(async ([k, m, p]) => {
  const r = await fetch('/mcp', { method: 'POST', headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json',
    accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) });
  return r.json();
}, [key, method, params]);
const toolNames = async (page, key) => (await rpc(page, key, 'tools/list')).result.tools.map((t) => t.name);
const card = (page, slug) => page.locator('article.server', { has: page.locator('code', { hasText: new RegExp(`^${slug}$`) }) });

let admin;
let member;
let memberKey;
let memberId;
let adminKey;
const original = {};
try {
  admin = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  const servers = (await json(admin, 'GET', '/api/upstreams')).body;
  const woo = servers.find((u) => u.slug === 'woo');
  const ev = servers.find((u) => u.slug === 'everything');
  for (const u of [woo, ev]) original[u.id] = { memberAccess: u.memberAccess, memberTools: u.memberTools };
  check('admin view shows the member rule per server', servers.every((u) => typeof u.memberAccess === 'string'));
  // Start from "all" so the change below is made by the form, not inherited.
  for (const u of [woo, ev]) await json(admin, 'PATCH', `/api/upstreams/${u.id}`, { memberAccess: 'all' });

  // Throwaway member with their own key.
  const email = `gus-${Date.now()}@example.invalid`;
  const password = `gus-${Math.random().toString(36).slice(2)}-pw`;
  const inv = (await json(admin, 'POST', '/api/invites', { email })).body;
  const tmp = await (await browser.newContext()).newPage();
  await tmp.goto(`${APP}/login`);
  await tmp.evaluate(async (b) => fetch('/api/invites/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }),
    { token: inv.inviteUrl.split('#')[1], name: 'Gus Member', password });
  member = await signIn(email, password);
  memberId = (await json(member, 'GET', '/api/me')).body.id;
  memberKey = (await json(member, 'POST', '/api/keys', { name: 'e2e-permissions' })).body;
  adminKey = (await json(admin, 'POST', '/api/keys', { name: 'e2e-permissions-admin' })).body;
  const allTools = await toolNames(member, memberKey.key);
  check('before: member sees woo create_product and everything tools', allTools.includes('woo__create_product') && allTools.some((n) => n.startsWith('everything__')), `${allTools.length} tools`);

  // Admin: woo → selected read tools, in the form.
  await card(admin, 'woo').getByRole('link', { name: 'Edit' }).click();
  await admin.waitForURL(/\/servers\/.+\/edit$/);
  await admin.getByLabel('Selected tools').check();
  const group = admin.getByRole('group', { name: 'Tools members may use' });
  await group.getByRole('checkbox').first().waitFor();
  for (const box of await group.getByRole('checkbox').all()) {
    const name = (await box.locator('xpath=..').textContent()).trim();
    if (READ_TOOLS.includes(name)) await box.check(); else await box.uncheck();
  }
  await admin.screenshot({ path: `${OUT}/bon-01-woo-member-access.png`, fullPage: true });
  await admin.getByRole('button', { name: 'Save changes' }).click();
  await admin.waitForURL(`${APP}/servers`);
  const rule = card(admin, 'woo').getByText(/^only /);
  await rule.waitFor();
  const ruleText = await rule.textContent();
  check('woo card shows the rule', READ_TOOLS.every((t) => ruleText.includes(t)) && !ruleText.includes('create_product'), ruleText);

  // Admin: everything → no access.
  await card(admin, 'everything').getByRole('link', { name: 'Edit' }).click();
  await admin.waitForURL(/\/servers\/.+\/edit$/);
  await admin.getByLabel('No access').check();
  await admin.getByRole('button', { name: 'Save changes' }).click();
  await admin.waitForURL(`${APP}/servers`);
  await admin.screenshot({ path: `${OUT}/bon-01-admin-servers.png`, fullPage: true });

  // Member over /mcp: only the read tools of woo, nothing of everything; other servers unchanged.
  const now = await toolNames(member, memberKey.key);
  const wooNow = now.filter((n) => n.startsWith('woo__')).sort();
  check('member tools/list: woo read tools only', JSON.stringify(wooNow) === JSON.stringify(READ_TOOLS.map((t) => `woo__${t}`).sort()), wooNow.join(','));
  check('member tools/list: no everything tools', !now.some((n) => n.startsWith('everything__')));
  check('member tools/list: github unchanged', now.filter((n) => n.startsWith('github__')).length === allTools.filter((n) => n.startsWith('github__')).length);
  const denied = await rpc(member, memberKey.key, 'tools/call', { name: 'woo__create_product', arguments: { name: 'should not exist', regular_price: '1' } });
  check('member direct call to woo__create_product refused', /tool not allowed for your role/.test(denied.error?.message ?? ''), denied.error?.message);
  const ok = await rpc(member, memberKey.key, 'tools/call', { name: 'woo__list_orders', arguments: { per_page: 1 } });
  check('member woo__list_orders still works', ok.result && !ok.result.isError);
  const adminNow = await toolNames(admin, adminKey.key);
  check('admin still has every tool', adminNow.length === allTools.length && adminNow.includes('woo__create_product'), `${adminNow.length}`);

  // Member's Servers page follows the same rule.
  await member.goto(`${APP}/servers`);
  await card(member, 'woo').waitFor();
  check('member page: everything hidden', await card(member, 'everything').count() === 0);
  check('member page: woo shows 3 tools', await card(member, 'woo').getByText(/^3 tools/).isVisible());
  await card(member, 'woo').getByRole('button', { name: 'Show tools' }).click();
  await member.locator('ul.tools li').first().waitFor();
  check('member page: woo tool list = read tools', await member.locator('ul.tools li').count() === 3);
  await member.screenshot({ path: `${OUT}/bon-01-member-servers.png`, fullPage: true });

  // Audit: the refusal is recorded under the member.
  const audit = (await json(admin, 'GET', `/api/audit?user=${memberId}&outcome=rejected`)).body;
  check('audit: refused call under the member (rejected, tool_forbidden)',
    audit.items?.some((r) => r.errorCode === 'tool_forbidden' && r.upstream === 'woo'));
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  check('flow completed', false, e.message.split('\n')[0]);
} finally {
  if (admin) {
    for (const [id, rule] of Object.entries(original)) {
      const r = await json(admin, 'PATCH', `/api/upstreams/${id}`, rule.memberAccess === 'selected' ? rule : { memberAccess: rule.memberAccess });
      check('rule restored', r.status === 200, String(r.status));
    }
    if (memberKey) await json(admin, 'DELETE', `/api/keys/${memberKey.id}`);
    if (adminKey) await json(admin, 'DELETE', `/api/keys/${adminKey.id}`);
    if (memberId) check('throwaway member disabled', (await json(admin, 'PATCH', `/api/users/${memberId}`, { disabled: true })).status === 200);
  }
  await browser.close();
}
const failed = results.filter((x) => !x).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
