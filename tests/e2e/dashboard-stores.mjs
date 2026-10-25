// TC-BON-12-2 (BON-12, BON-14): the Stores page on a real cluster. A member creates three stores at once (the per-member
// cap), they reach Ready, a fourth is refused; the admin sees pods and quota for them (runtime line, refreshed by the
// provisioner about every 30 s) and resets a wp-admin password (a one-off wp-cli Job inside the store) — the member's owner
// view never shows those admin extras; the first password is shown once; a second person is shared one store and sees it
// read-only; everything is deleted again and gone from the list and the servers. Takes about 6–10 minutes (store start-up).
// Forced failure (Failed + reason) is not forced here: the reason path is TC-BON-09 (timeout) and the stand-in browser run.
// Throwaway members hal-<ts> and ivy-<ts>@example.invalid are disabled by scripts/dashboard-screens.sh afterwards.
import { chromium } from 'playwright';

const APP = process.env.APP_URL ?? 'http://app.127.0.0.1.nip.io';
const OUT = '/out';
const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
const STAMP = Date.now().toString(36).slice(-5);
const NAMES = [`Ui Chai ${STAMP}`, `Ui Bags ${STAMP}`, `Ui Desk ${STAMP}`];
const SLUGS = NAMES.map((n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
const NICHES = ['tea-coffee', 'bags', 'stationery'];
const READY_MS = Number(process.env.READY_TIMEOUT_S ?? 720) * 1000;
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` (${extra})` : ''}`); return ok; };

const browser = await chromium.launch();
const errors = [];
async function signIn(email, password, next = '/stores') {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.goto(`${APP}/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${APP}${next}`);
  return page;
}
const json = (page, method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch(u, { method: m, ...(b ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) } : {}) });
  return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
}, [method, url, body]);
const card = (page, name) => page.locator('article', { has: page.getByRole('heading', { name: new RegExp(`^${name}`) }) });
async function member(admin, prefix) {
  const email = `${prefix}-${Date.now()}@example.invalid`;
  const password = `${prefix}-${Math.random().toString(36).slice(2)}-pw`;
  const inv = (await json(admin, 'POST', '/api/invites', { email })).body;
  const tmp = await (await browser.newContext()).newPage();
  await tmp.goto(`${APP}/login`);
  await tmp.evaluate(async (b) => fetch('/api/invites/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }),
    { token: inv.inviteUrl.split('#')[1], name: `${prefix} Member`, password });
  await tmp.context().close();
  return { email, password };
}

let admin; let hal; let ivy;
const created = [];
try {
  admin = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  const halCred = await member(admin, 'hal');
  const ivyCred = await member(admin, 'ivy');
  hal = await signIn(halCred.email, halCred.password);
  ivy = await signIn(ivyCred.email, ivyCred.password);
  const limits = (await json(hal, 'GET', '/api/stores')).body.limits;
  check('the Stores page loads with the caps', limits.maxPerMember >= 3, `per member ${limits.maxPerMember}, total ${limits.maxTotal}, now ${limits.total}`);
  if (limits.maxTotal - limits.total < 3) throw new Error(`need room for 3 stores (platform has ${limits.total} of ${limits.maxTotal}); delete some first`);

  // Three at once, from the form.
  for (const [i, name] of NAMES.entries()) {
    await hal.getByLabel('Name', { exact: true }).fill(name);
    await hal.getByLabel('Niche').selectOption(NICHES[i]);
    await hal.getByRole('button', { name: 'Create store' }).click();
    await card(hal, name).waitFor();
    created.push(SLUGS[i]);
  }
  check('TC-BON-12-2a three stores created at once, each shown Creating…', (await hal.getByText('Creating…').count()) >= 1);
  await hal.screenshot({ path: `${OUT}/bon-12-creating.png`, fullPage: true });
  const t0 = Date.now();
  for (const name of NAMES) await card(hal, name).getByText('Ready', { exact: true }).waitFor({ timeout: READY_MS });
  check('TC-BON-12-2b all three reach Ready without a reload', true, `${Math.round((Date.now() - t0) / 1000)} s after the last click`);
  await hal.screenshot({ path: `${OUT}/bon-12-ready.png`, fullPage: true });
  const open = await card(hal, NAMES[0]).getByRole('link', { name: /Open store/ }).getAttribute('href');
  check('the store link is the store\'s own host', new RegExp(`^https?://${SLUGS[0]}\\.store\\.`).test(open ?? ''), open ?? '');

  // Cap.
  await hal.getByLabel('Name', { exact: true }).fill(`Ui Fourth ${STAMP}`);
  await hal.getByRole('button', { name: 'Create store' }).click();
  await hal.getByText(/you already own 3 stores \(limit 3\)/).waitFor();
  check('TC-BON-12-2c a fourth store is refused with a clear message', true);

  // Owner view: password once, no admin extras.
  const mine = card(hal, NAMES[0]);
  await mine.getByRole('button', { name: /Settings, sharing and delete/ }).click();
  await mine.getByRole('button', { name: /Show the password/ }).click();
  const first = await mine.locator('.once input').inputValue();
  await mine.getByRole('button', { name: 'Hide', exact: true }).click();
  await mine.getByText('Already shown').waitFor();
  check('TC-BON-12-2d the wp-admin password is shown once (owner)', first.length >= 16);
  check('the owner (not an admin) has no reset button and no runtime line', (await mine.getByRole('button', { name: /Reset the password/ }).count()) === 0 && (await mine.getByLabel('Runtime').count()) === 0);

  // Admin: runtime and reset.
  await admin.reload();
  const adm = card(admin, NAMES[0]);
  await adm.getByLabel('Runtime').waitFor({ timeout: 120_000 });
  const line = await adm.getByLabel('Runtime').innerText();
  check('TC-BON-12-2e admin sees pods and quota for the store', /Pods \d+\/\d+ ready/.test(line) && /CPU limits/.test(line), line);
  await adm.getByRole('button', { name: /Settings, sharing and delete/ }).click();
  await adm.getByRole('button', { name: /Reset the password/ }).click();
  await adm.getByText('Setting a new password in the store…').waitFor();
  await adm.getByRole('button', { name: /Show the password/ }).waitFor({ timeout: 240_000 });
  await adm.getByRole('button', { name: /Show the password/ }).click();
  const second = await adm.locator('.once input').inputValue();
  check('TC-BON-12-2f admin reset: a new password, shown once, different from the first', second.length >= 16 && second !== first);
  await admin.screenshot({ path: `${OUT}/bon-12-admin-reset.png`, fullPage: true });

  // Sharing: ivy sees the store read-only.
  await mine.getByLabel('Share with (their email)').fill(ivyCred.email);
  await mine.getByRole('button', { name: 'Share' }).click();
  await mine.getByText(ivyCred.email).waitFor();
  await ivy.reload();
  const shared = card(ivy, NAMES[0]);
  await shared.waitFor();
  check('TC-BON-12-2g a person it is shared with sees the store, with no settings', (await shared.getByText(/shared by hal/i).count()) > 0 && (await shared.getByRole('button', { name: /Settings/ }).count()) === 0);
  check('and not the other two', (await card(ivy, NAMES[1]).count()) === 0 && (await card(ivy, NAMES[2]).count()) === 0);
  const ivyServers = (await json(ivy, 'GET', '/api/upstreams')).body.map((u) => u.slug);
  check('their server list holds only that store\'s server', JSON.stringify(ivyServers.filter((s) => s.startsWith('woo-ui-'))) === JSON.stringify([`woo-${SLUGS[0]}`]), ivyServers.filter((s) => s.startsWith('woo-ui-')).join(','));

  // Delete all three.
  for (const [i, name] of NAMES.entries()) {
    const c = card(hal, name);
    if (i !== 0) await c.getByRole('button', { name: /Settings, sharing and delete/ }).click();
    await c.getByPlaceholder(SLUGS[i]).fill(SLUGS[i]);
    await c.getByRole('button', { name: 'Delete store' }).click();
  }
  check('TC-BON-12-2h deleting shows Deleting…', (await hal.getByText('Deleting…').count()) >= 1);
  for (const name of NAMES) await card(hal, name).waitFor({ state: 'detached', timeout: 300_000 });
  created.length = 0;
  const left = (await json(admin, 'GET', '/api/upstreams')).body.filter((u) => u.slug.startsWith('woo-ui-'));
  check('all three disappear from the list and their servers from the gateway', left.length === 0);
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('script completed', false, String(e.message ?? e).slice(0, 300));
} finally {
  // Best-effort cleanup of anything still there.
  if (admin) for (const slug of created) {
    const s = (await json(admin, 'GET', '/api/stores')).body?.stores?.find((x) => x.slug === slug);
    if (s) await json(admin, 'DELETE', `/api/stores/${s.id}?confirm=${slug}`).catch(() => {});
  }
  await browser.close();
}
const failed = results.filter((x) => !x).length;
console.log(failed ? `\nFAIL  TC-BON-12-2 stores page (${failed} of ${results.length})` : `\nPASS  TC-BON-12-2 stores page (${results.length}/${results.length})`);
process.exit(failed ? 1 : 0);
