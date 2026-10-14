// TC-UI-03-1 (UI-03): dashboard sign-in, sign-out and invite acceptance in a real browser, against the
// deployed stack. Run through scripts/dashboard-screens.sh (official Playwright image).
//   admin login (wrong password first) → invite a member (API, from the page) → sign out →
//   open the invite link → create the account → member nav → reuse the link (refused) → deep link.
import { chromium } from 'playwright';

const APP = process.env.APP_URL ?? 'http://app.127.0.0.1.nip.io';
const OUT = '/out';
const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` (${extra})` : ''}`); };

const browser = await chromium.launch();
const consoleErrors = [];
async function newPage(viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  return page;
}
const navLabels = (page) => page.locator('header nav a').allTextContents();

try {
  // 1. Anonymous → /login, with the original path kept in ?next.
  const admin = await newPage();
  await admin.goto(`${APP}/audit`);
  await admin.waitForURL(/\/login\?next=%2Faudit/);
  check('anonymous /audit → /login?next=/audit', true);
  await admin.screenshot({ path: `${OUT}/ui-03-login.png` });

  // 2. Wrong password → generic message, password field cleared.
  await admin.getByLabel('Email').fill(ADMIN_EMAIL);
  await admin.getByLabel('Password').fill('definitely-not-the-password');
  await admin.getByRole('button', { name: 'Sign in' }).click();
  await admin.getByRole('alert').waitFor();
  check('wrong password → "Wrong email or password."', (await admin.getByRole('alert').textContent()) === 'Wrong email or password.');
  check('password field cleared after a failure', (await admin.getByLabel('Password').inputValue()) === '');

  // 3. Right password → back to /audit (admin page); admin nav.
  await admin.getByLabel('Password').fill(ADMIN_PASSWORD);
  await admin.getByRole('button', { name: 'Sign in' }).click();
  await admin.waitForURL(`${APP}/audit`);
  check('admin login → returns to /audit', true);
  const adminNav = await navLabels(admin);
  check('admin nav has Members and Audit log', adminNav.includes('Members') && adminNav.includes('Audit log'), adminNav.join(', '));
  await admin.getByRole('link', { name: 'Overview' }).click();
  await admin.getByRole('heading', { name: /Welcome/ }).waitFor();
  await admin.screenshot({ path: `${OUT}/ui-03-admin-overview.png` });

  // 4. Invite a member (the Members page is UI-09; the API call runs in the page, so it carries the
  //    session cookie and the browser's own Origin header like any dashboard request).
  const email = `carol-${Date.now()}@example.invalid`;
  const invite = await admin.evaluate(async (e) => {
    const r = await fetch('/api/invites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e, role: 'member' }) });
    return { status: r.status, body: await r.json() };
  }, email);
  check('POST /api/invites from the dashboard origin → 201', invite.status === 201, String(invite.status));
  const inviteUrl = invite.body.inviteUrl;

  // 5. Sign out → /login; the session is gone server-side.
  await admin.getByRole('button', { name: 'Sign out' }).click();
  await admin.waitForURL(/\/login/);
  const meAfter = await admin.evaluate(() => fetch('/api/me').then((r) => r.status));
  check('sign out → /login and /api/me 401', meAfter === 401, String(meAfter));

  // 6. Invite link in a fresh browser: the token leaves the address bar, account is created, member is signed in.
  const member = await newPage();
  await member.goto(inviteUrl);
  await member.getByText(`You were invited as ${email}`).waitFor();
  check('invite page shows the invited email', true);
  check('token removed from the address bar', !member.url().includes('#'), member.url());
  await member.screenshot({ path: `${OUT}/ui-03-invite.png` });
  await member.getByLabel('Your name').fill('Carol Member');
  await member.getByLabel(/^Password/).fill('short');
  await member.getByLabel('Repeat password').fill('short');
  await member.getByRole('button', { name: 'Create account' }).click();
  // The browser's own minLength check blocks submit first; either way no request is made.
  check('weak password not submitted', member.url().endsWith('/invite'));
  const pw = 'carols-long-password-1';
  await member.getByLabel(/^Password/).fill(pw);
  await member.getByLabel('Repeat password').fill(`${pw}x`);
  await member.getByRole('button', { name: 'Create account' }).click();
  check('mismatched passwords → message', (await member.getByRole('alert').textContent()) === 'The passwords do not match.');
  await member.getByLabel('Repeat password').fill(pw);
  await member.getByRole('button', { name: 'Create account' }).click();
  await member.getByRole('heading', { name: 'Welcome, Carol Member' }).waitFor();
  check('accept → signed in as the new member', true);
  const memberNav = await navLabels(member);
  check('member nav has no Members / Audit log', !memberNav.includes('Members') && !memberNav.includes('Audit log'), memberNav.join(', '));
  await member.screenshot({ path: `${OUT}/ui-03-member-overview.png` });
  await member.goto(`${APP}/members`);
  await member.waitForURL(`${APP}/`);
  check('member opening /members → sent to /', true);
  const forbidden = await member.evaluate(() => fetch('/api/invites').then((r) => r.status));
  check('member GET /api/invites → 403 (server-side, not just hidden)', forbidden === 403, String(forbidden));

  // 7. The same link again → refused.
  const again = await newPage();
  await again.goto(inviteUrl);
  await again.getByRole('alert').waitFor();
  check('reused invite → "already been used"', /already been used/.test(await again.getByRole('alert').textContent()));

  // 8. Member signs out and back in via a deep link.
  await member.getByRole('button', { name: 'Sign out' }).click();
  await member.waitForURL(/\/login/);
  await member.goto(`${APP}/keys`);
  await member.waitForURL(/\/login\?next=%2Fkeys/);
  await member.getByLabel('Email').fill(email);
  await member.getByLabel('Password').fill(pw);
  await member.getByRole('button', { name: 'Sign in' }).click();
  await member.waitForURL(`${APP}/keys`);
  check('member login via deep link → /keys', true);

  // 9. Open-redirect guard and phone width.
  const evil = await newPage({ width: 390, height: 844 });
  await evil.goto(`${APP}/login?next=//evil.example/x`);
  await evil.getByLabel('Email').fill(email);
  await evil.getByLabel('Password').fill(pw);
  await evil.screenshot({ path: `${OUT}/ui-03-login-mobile.png` });
  await evil.getByRole('button', { name: 'Sign in' }).click();
  await evil.waitForURL(`${APP}/`);
  check('?next=//evil.example → stays on the dashboard', new URL(evil.url()).host === new URL(APP).host);
  const overflow = await evil.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check('no horizontal scroll at 390 px', !overflow);
  await evil.screenshot({ path: `${OUT}/ui-03-overview-mobile.png` });

  // Expected 401s (signed-out /api/me) show as console errors; anything else is a bug (e.g. CSP).
  const unexpected = consoleErrors.filter((t) => !/401|403|410|Unauthorized|Forbidden|Gone/.test(t));
  check('no unexpected console errors (CSP, exceptions)', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
} catch (e) {
  check('flow completed', false, e.message.split('\n')[0]);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
