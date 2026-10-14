// TC-UI-05-1 / TC-UI-06-1 / TC-UI-07-1 / TC-UI-08-1: an admin adds, edits, disables, enables and deletes
// an MCP server in the dashboard; the gateway's /mcp tool list follows each step (checked with a
// temporary API key from the same session, revoked at the end). A member sees no admin actions and is
// refused by the API. The test server is a second registration of the in-cluster everything-mcp
// (allowlisted host), so nothing outside the cluster is touched.
import { chromium } from 'playwright';

const APP = process.env.APP_URL ?? 'http://app.127.0.0.1.nip.io';
const OUT = '/out';
const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
const SLUG = `ev${Date.now().toString(36).slice(-5)}`;
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
  // content-type only with a body: Fastify answers 400 to an empty body declared as JSON.
  const r = await fetch(u, { method: m, ...(b ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) } : {}) });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
}, [method, url, body]);
/** tools/list through the gateway /mcp with an API key, like any MCP client. */
const mcpTools = (page, key) => page.evaluate(async (k) => {
  const r = await fetch('/mcp', { method: 'POST', headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json',
    accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  return (await r.json()).result.tools.map((t) => t.name);
}, key);
const card = (page, name) => page.locator('article.server', { has: page.getByRole('heading', { name: new RegExp(`^${name}`) }) });

let admin;
let apiKey;
try {
  admin = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  apiKey = (await json(admin, 'POST', '/api/keys', { name: 'e2e-server-admin' })).body;
  const before = await mcpTools(admin, apiKey.key);
  check('baseline /mcp tools/list', before.length > 0 && !before.some((n) => n.startsWith(`${SLUG}__`)), `${before.length} tools`);

  // UI-05: SSRF attempt from the form → readable error, nothing created.
  await admin.getByRole('link', { name: 'Add server' }).click();
  await admin.waitForURL(`${APP}/servers/new`);
  await admin.getByLabel('Name', { exact: true }).fill('Metadata probe');
  await admin.getByLabel(/^Slug/).fill(`${SLUG}x`);
  await admin.getByLabel(/^URL/).fill('http://169.254.169.254/latest/meta-data/');
  await admin.getByRole('button', { name: 'Add server' }).click();
  await admin.getByRole('alert').waitFor();
  check('SSRF URL refused in the form', /link-local\/metadata/.test(await admin.getByRole('alert').textContent()));
  await admin.screenshot({ path: `${OUT}/ui-05-ssrf-refused.png`, fullPage: true });

  // UI-05: add a real server with a bearer credential.
  await admin.getByLabel('Name', { exact: true }).fill(`Everything copy ${SLUG}`);
  await admin.getByLabel(/^Slug/).fill(SLUG);
  await admin.getByLabel(/^URL/).fill('http://everything-mcp.platform.svc.cluster.local/mcp');
  await admin.getByLabel('Bearer token').check();
  await admin.getByLabel(/^Token/).fill('e2e-dummy-token-not-a-secret');
  await admin.screenshot({ path: `${OUT}/ui-05-add-form.png`, fullPage: true });
  await admin.getByRole('button', { name: 'Add server' }).click();
  await admin.waitForURL(`${APP}/servers`);
  const c = card(admin, `Everything copy ${SLUG}`);
  await c.locator('.status', { hasText: 'Connected' }).waitFor({ timeout: 30_000 });
  check('new server appears and connects', true);
  check('credential shown only as "stored"', await c.getByText('credential stored (encrypted, never shown)').isVisible()
    && !(await admin.content()).includes('e2e-dummy-token-not-a-secret'));
  const added = await mcpTools(admin, apiKey.key);
  check('its tools are on /mcp', added.includes(`${SLUG}__echo`), `${added.filter((n) => n.startsWith(`${SLUG}__`)).length} new`);
  await admin.screenshot({ path: `${OUT}/ui-05-added.png`, fullPage: true });

  // UI-06: edit the name; slug read-only; token field empty with a "keep" hint.
  await c.getByRole('link', { name: 'Edit' }).click();
  await admin.waitForURL(/\/servers\/.+\/edit$/);
  check('slug is read-only on edit', (await admin.getByLabel(/^Slug/).getAttribute('readonly')) !== null);
  check('token field empty, "leave empty to keep"', (await admin.getByLabel(/^Token/).inputValue()) === ''
    && await admin.getByText('leave empty to keep it').isVisible());
  await admin.screenshot({ path: `${OUT}/ui-06-edit.png`, fullPage: true });
  await admin.getByLabel('Name', { exact: true }).fill(`Renamed ${SLUG}`);
  await admin.getByRole('button', { name: 'Save changes' }).click();
  await admin.waitForURL(`${APP}/servers`);
  const r = card(admin, `Renamed ${SLUG}`);
  await r.waitFor();
  await r.locator('.status', { hasText: 'Connected' }).waitFor({ timeout: 30_000 });
  check('rename saved, credential kept, still Connected', await r.getByText('credential stored').isVisible());

  // UI-07: disable → tools gone from /mcp; enable → back.
  await r.getByRole('button', { name: 'Disable' }).click();
  await r.locator('.status', { hasText: 'Disabled' }).waitFor();
  const off = await mcpTools(admin, apiKey.key);
  check('disable → badge Disabled, tools gone from /mcp', !off.some((n) => n.startsWith(`${SLUG}__`)));
  await admin.screenshot({ path: `${OUT}/ui-07-disabled.png`, fullPage: true });
  await r.getByRole('button', { name: 'Enable' }).click();
  await r.locator('.status', { hasText: 'Connected' }).waitFor({ timeout: 30_000 });
  check('enable → Connected, tools back', (await mcpTools(admin, apiKey.key)).includes(`${SLUG}__echo`));

  // UI-08: a member sees no admin actions and the API refuses them.
  const email = `erin-${Date.now()}@example.invalid`;
  const password = `erin-${Math.random().toString(36).slice(2)}-pw`;
  const inv = (await json(admin, 'POST', '/api/invites', { email })).body;
  const tmp = await (await browser.newContext()).newPage();
  await tmp.goto(`${APP}/login`);
  await tmp.evaluate(async (b) => fetch('/api/invites/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }),
    { token: inv.inviteUrl.split('#')[1], name: 'Erin Member', password });
  const member = await signIn(email, password);
  await card(member, `Renamed ${SLUG}`).waitFor();
  const actions = await member.getByRole('button', { name: /^(Disable|Enable|Delete)$/ }).count()
    + await member.getByRole('link', { name: /^(Edit|Add server)$/ }).count();
  check('member: no Add/Edit/Disable/Delete', actions === 0, `${actions} found`);
  const id = (await json(admin, 'GET', '/api/upstreams')).body.find((u) => u.slug === SLUG).id;
  const mp = await json(member, 'PATCH', `/api/upstreams/${id}`, { enabled: false });
  const md = await json(member, 'DELETE', `/api/upstreams/${id}`);
  check('member PATCH/DELETE → 403', mp.status === 403 && md.status === 403, `${mp.status}/${md.status}`);
  await member.goto(`${APP}/servers/new`);
  await member.waitForURL(`${APP}/`);
  check('member /servers/new → sent to /', true);

  // UI-07: delete with in-page confirm.
  await r.getByRole('button', { name: 'Delete' }).click();
  await r.getByText(`Delete Renamed ${SLUG}? Its tools disappear for everyone.`).waitFor();
  await admin.screenshot({ path: `${OUT}/ui-07-delete-confirm.png`, fullPage: true });
  await r.getByRole('group').getByRole('button', { name: 'Delete' }).click();
  await card(admin, `Renamed ${SLUG}`).waitFor({ state: 'detached' });
  const gone = await mcpTools(admin, apiKey.key);
  check('delete → card gone, tools gone from /mcp', !gone.some((n) => n.startsWith(`${SLUG}__`)) && gone.length === before.length,
    `${gone.length} tools (baseline ${before.length})`);
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  check('flow completed', false, e.message.split('\n')[0]);
} finally {
  if (admin) {
    // Clean up whatever is left: the test server and the temporary key.
    const left = (await json(admin, 'GET', '/api/upstreams').catch(() => ({ body: [] }))).body.filter?.((u) => u.slug.startsWith(SLUG)) ?? [];
    for (const u of left) await json(admin, 'DELETE', `/api/upstreams/${u.id}`);
    if (apiKey) {
      const rv = await json(admin, 'DELETE', `/api/keys/${apiKey.id}`);
      check('temporary API key revoked', rv.status === 204, String(rv.status));
    }
  }
  await browser.close();
}
const failed = results.filter((x) => !x).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
