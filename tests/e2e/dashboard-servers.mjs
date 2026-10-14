// TC-UI-04-1 (UI-04, REQ-GW-09/10, REQ-DOD-10): the Servers page shows every upstream with status and
// tools, and — without a reload — turns a killed upstream's badge to Unreachable and back to Connected.
// The pod is scaled by scripts/dashboard-screens.sh on the host; this script asks for it through marker
// files in /out (/out/.want-kill, /out/.want-restore) and the host answers by scaling the Deployment.
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const APP = process.env.APP_URL ?? 'http://app.127.0.0.1.nip.io';
const OUT = '/out';
const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` (${extra})` : ''}`); };
const ask = (what) => { writeFileSync(`${OUT}/.want-${what}`, ''); };
for (const f of ['.want-kill', '.want-restore']) rmSync(`${OUT}/${f}`, { force: true });

const browser = await chromium.launch();
const errors = [];
async function signIn(email, password, viewport = { width: 1280, height: 900 }) {
  const page = await (await browser.newContext({ viewport })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${APP}/login?next=%2Fservers`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${APP}/servers`);
  return page;
}
const card = (page, name) => page.locator('article.server', { has: page.getByRole('heading', { name: new RegExp(`^${name}`) }) });
const badge = (page, name) => card(page, name).locator('.status');

try {
  const admin = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  for (const n of ['WooCommerce', 'Everything', 'GitHub']) await badge(admin, n).filter({ hasText: 'Connected' }).waitFor({ timeout: 30_000 });
  check('admin: WooCommerce, Everything, GitHub all Connected', true);
  const counts = await admin.locator('article.server p.small').first().textContent();
  check('tool count shown', /\d+ tools/.test(counts ?? ''), counts ?? '');
  check('admin sees URL and "never shown" credential note', await card(admin, 'WooCommerce').getByText('credential stored (encrypted, never shown)').isVisible());

  await card(admin, 'WooCommerce').getByRole('button', { name: 'Show tools' }).click();
  await card(admin, 'WooCommerce').getByText('woo__list_orders').waitFor();
  const woo = await card(admin, 'WooCommerce').locator('.tools li').count();
  check('WooCommerce tools expand with public names', woo >= 5, `${woo} tools`);
  check('required parameters marked', await card(admin, 'WooCommerce').getByText(/Parameters:.*\*/).first().isVisible());
  await admin.screenshot({ path: `${OUT}/ui-04-servers-admin.png`, fullPage: true });

  // Kill everything-mcp; the open page must turn its badge red by itself (10 s refresh + 10 s health loop).
  const t0 = Date.now();
  ask('kill');
  await badge(admin, 'Everything').filter({ hasText: 'Unreachable' }).waitFor({ timeout: 60_000 });
  check('pod killed → Everything Unreachable without reload', true, `${Math.round((Date.now() - t0) / 1000)} s`);
  check('others still Connected', (await badge(admin, 'WooCommerce').textContent()) === 'Connected'
    && (await badge(admin, 'GitHub').textContent()) === 'Connected');
  check('error text shown, no internal URL', await card(admin, 'Everything').getByText(/^Error: upstream everything unreachable/).isVisible()
    && !(await card(admin, 'Everything').locator('p.error').textContent()).includes('svc.cluster.local'));
  check('Show tools disabled while unreachable', await card(admin, 'Everything').getByRole('button', { name: 'Show tools' }).isDisabled());
  await admin.screenshot({ path: `${OUT}/ui-04-servers-unreachable.png`, fullPage: true });

  const t1 = Date.now();
  ask('restore');
  await badge(admin, 'Everything').filter({ hasText: 'Connected' }).waitFor({ timeout: 120_000 });
  check('pod back → Everything Connected without reload', true, `${Math.round((Date.now() - t1) / 1000)} s`);
  check('last error kept after recovery', await card(admin, 'Everything').getByText(/^Last error: /).isVisible());

  // Member (a throwaway one, invited and accepted through the API): same list and status, no connection details.
  {
    const email = `dora-${Date.now()}@example.invalid`;
    const password = `dora-${Math.random().toString(36).slice(2)}-pw`;
    const inv = await admin.evaluate(async (e) => (await fetch('/api/invites', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: e }) })).json(), email);
    const token = inv.inviteUrl.split('#')[1];
    const tmp = await (await browser.newContext()).newPage();
    await tmp.goto(`${APP}/login`);
    const st = await tmp.evaluate(async (b) => (await fetch('/api/invites/accept', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(b) })).status, { token, name: 'Dora Member', password });
    check('throwaway member created', st === 201, String(st));
    const member = await signIn(email, password, { width: 390, height: 844 });
    await badge(member, 'WooCommerce').filter({ hasText: 'Connected' }).waitFor();
    check('member sees the servers', (await member.locator('article.server').count()) >= 3);
    check('member sees no URL / auth details', (await member.getByText('URL', { exact: true }).count()) === 0
      && !(await member.content()).includes('svc.cluster.local'));
    const overflow = await member.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check('no horizontal scroll at 390 px', !overflow);
    await member.screenshot({ path: `${OUT}/ui-04-servers-member-mobile.png`, fullPage: true });
  }
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  check('flow completed', false, e.message.split('\n')[0]);
} finally {
  if (!existsSync(`${OUT}/.want-restore`)) ask('restore'); // never leave the upstream scaled down
  await browser.close();
}
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
