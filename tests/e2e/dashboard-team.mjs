// TC-UI-09-1 / TC-UI-10-1 / TC-UI-11-1 / TC-UI-12-1: team management in the dashboard, end to end.
//   admin invites a member from the Members page → the copied link creates the account → the member
//   creates a key on the API keys page and uses it on /mcp like any MCP client → the admin sees the
//   call in the audit log within 10 s (no reload) → the admin revokes that key from "All keys" → the
//   client is refused on its next call → the admin issues a key for the member → it works → the admin
//   disables the member → session and key stop → enable. An open invite is withdrawn.
// Leaves one disabled-then-enabled member fay-<ts>@example.invalid; revokes every key it created.
import { chromium } from 'playwright';

const APP = process.env.APP_URL ?? 'http://app.127.0.0.1.nip.io';
const OUT = '/out';
const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
const TS = Date.now();
const FAY = `fay-${TS}@example.invalid`;
const NAME = `Fay ${String(TS).slice(-6)}`; // unique per run: earlier runs leave members behind
const FAY_PW = `fay-${Math.random().toString(36).slice(2)}-pw`;
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` (${extra})` : ''}`); };

const browser = await chromium.launch();
const errors = [];
async function page(viewport = { width: 1280, height: 900 }) {
  const p = await (await browser.newContext({ viewport })).newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  return p;
}
async function signIn(p, email, password, next) {
  await p.goto(`${APP}/login?next=${encodeURIComponent(next)}`);
  await p.getByLabel('Email').fill(email);
  await p.getByLabel('Password').fill(password);
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.waitForURL(`${APP}${next}`);
}
/** One JSON-RPC request to /mcp with a Bearer key, exactly like an external MCP client. */
const mcp = (p, key, method, params) => p.evaluate(async ([k, m, pr]) => {
  const r = await fetch('/mcp', { method: 'POST', headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json',
    accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, ...(pr ? { params: pr } : {}) }) });
  const body = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
  return { status: r.status, body };
}, [key, method, params]);
const created = []; // key ids to revoke at the end (via the admin session)

let admin;
try {
  admin = await page();
  await signIn(admin, ADMIN_EMAIL, ADMIN_PASSWORD, '/members');

  // UI-09: invite from the Members page; the link is shown once with a copy control.
  await admin.getByLabel('Email').fill(FAY);
  await admin.getByRole('button', { name: 'Create invite link' }).click();
  const linkBox = admin.getByLabel(`Invite link for ${FAY}`);
  await linkBox.waitFor();
  const inviteUrl = await linkBox.inputValue();
  check('invite link shown once', inviteUrl.startsWith(`${APP}/invite#`));
  await admin.getByRole('button', { name: 'Copy' }).click();
  await admin.getByRole('button', { name: 'Copied' }).or(admin.getByText('Selected — press Ctrl+C')).first().waitFor();
  check('copy control reacts', true);
  await admin.getByRole('cell', { name: FAY }).waitFor();
  check('open invite listed', true);
  await admin.screenshot({ path: `${OUT}/ui-09-invite.png`, fullPage: true });

  // A second invite, withdrawn: its link must die.
  const ghost = `ghost-${TS}@example.invalid`;
  await admin.getByLabel('Email').fill(ghost);
  await admin.getByRole('button', { name: 'Create invite link' }).click();
  const ghostUrl = await admin.getByLabel(`Invite link for ${ghost}`).inputValue();
  await admin.getByRole('row', { name: new RegExp(ghost) }).getByRole('button', { name: 'Withdraw' }).click();
  await admin.getByRole('cell', { name: ghost }).waitFor({ state: 'detached' });
  const ghostPage = await page();
  await ghostPage.goto(ghostUrl);
  await ghostPage.getByRole('alert').waitFor();
  check('withdrawn invite link → refused', /not found/i.test(await ghostPage.getByRole('alert').textContent()));

  // The copied link creates the account.
  const fay = await page();
  await fay.goto(inviteUrl);
  await fay.getByLabel('Your name').fill(NAME);
  await fay.getByLabel(/^Password/).fill(FAY_PW);
  await fay.getByLabel('Repeat password').fill(FAY_PW);
  await fay.getByRole('button', { name: 'Create account' }).click();
  await fay.getByRole('heading', { name: `Welcome, ${NAME}` }).waitFor();
  check('invite link works (TC-UI-09-1)', true);
  await admin.reload();
  await admin.getByRole('row', { name: new RegExp(NAME) }).waitFor();
  check('new member in the People table', true);

  // UI-11: Fay creates a key; it is shown once and works on /mcp.
  await fay.getByRole('link', { name: 'API keys', exact: true }).click();
  await fay.getByLabel(/^Name/).fill('laptop – inspector');
  await fay.getByRole('button', { name: 'Create key' }).click();
  const keyBox = fay.getByLabel('Your new key "laptop – inspector"');
  await keyBox.waitFor();
  const faysKey = await keyBox.inputValue();
  check('key shown once in full', /^mgw_[0-9A-Za-z]{43}$/.test(faysKey));
  await fay.screenshot({ path: `${OUT}/ui-11-new-key.png`, fullPage: true });
  const listed = await mcp(fay, faysKey, 'tools/list');
  check('the new key works on /mcp (tools/list)', listed.status === 200 && listed.body.result.tools.length > 0, `${listed.body?.result?.tools?.length} tools`);
  const echo = await mcp(fay, faysKey, 'tools/call', { name: 'everything__echo', arguments: { message: `audit-${TS}` } });
  check('tool call with the key', echo.status === 200 && !echo.body.result.isError);
  await fay.reload();
  await fay.getByRole('cell', { name: 'laptop – inspector', exact: true }).waitFor();
  check('after reload only the prefix is shown', !(await fay.content()).includes(faysKey) && (await fay.content()).includes(`${faysKey.slice(0, 12)}…`));

  // UI-12: the admin's open audit page shows Fay's call within ~10 s, without a reload.
  await admin.getByRole('link', { name: 'Audit log', exact: true }).click();
  await admin.waitForURL(`${APP}/audit`);
  await admin.getByLabel('User').selectOption({ label: NAME });
  await admin.getByRole('row', { name: new RegExp(`${NAME}.*everything.*echo.*ok`) }).first().waitFor({ timeout: 15_000 });
  check('Fay\'s echo call in the audit log (filtered by user)', true);
  const t0 = Date.now();
  await mcp(fay, faysKey, 'tools/call', { name: 'everything__get-sum', arguments: { a: 2, b: 40 } });
  await admin.getByRole('row', { name: new RegExp(`${NAME}.*everything.*get-sum.*ok`) }).waitFor({ timeout: 25_000 });
  check('a new call appears without reload (TC-UI-12-1)', true, `${Math.round((Date.now() - t0) / 1000)} s`);
  await admin.screenshot({ path: `${OUT}/ui-12-audit.png`, fullPage: true });

  // UI-10: the admin revokes Fay's key from "All keys" → her client is refused on the next call.
  await admin.getByRole('link', { name: 'API keys', exact: true }).click();
  await admin.getByRole('heading', { name: 'All keys (everyone)' }).waitFor();
  await admin.getByRole('button', { name: `Revoke laptop – inspector of ${NAME}` }).click();
  await admin.getByRole('button', { name: `Revoke laptop – inspector of ${NAME}` }).waitFor({ state: 'detached' });
  const after = await mcp(fay, faysKey, 'tools/list');
  check('revoked from the UI → next /mcp call 401 (TC-UI-10-1)', after.status === 401, String(after.status));

  // UI-10: issue a key for Fay.
  await admin.locator('form', { has: admin.getByRole('heading', { name: 'Issue a key for a member' }) }).locator('select').selectOption({ label: `${NAME} (${FAY})` });
  await admin.getByLabel('Key name').fill('issued by admin');
  await admin.getByRole('button', { name: 'Issue key' }).click();
  const issuedBox = admin.getByLabel(`Key "issued by admin" for ${NAME}`);
  await issuedBox.waitFor();
  const issued = await issuedBox.inputValue();
  check('issued key works for Fay', (await mcp(admin, issued, 'tools/list')).status === 200);
  await admin.screenshot({ path: `${OUT}/ui-10-keys-admin.png`, fullPage: true });

  // UI-09: disable Fay → her session and key stop at once; enable → back.
  await admin.getByRole('link', { name: 'Members', exact: true }).click();
  const row = admin.getByRole('row', { name: new RegExp(NAME) });
  await row.getByRole('button', { name: 'Disable' }).click();
  await row.getByText('Disabled').waitFor();
  const me = await fay.evaluate(async () => (await fetch('/api/me')).status);
  const keyOff = await mcp(fay, issued, 'tools/list');
  check('disable → session 401 and key 401 on the next request', me === 401 && keyOff.status === 401, `${me}/${keyOff.status}`);
  await admin.screenshot({ path: `${OUT}/ui-09-members.png`, fullPage: true });
  await row.getByRole('button', { name: 'Enable' }).click();
  await row.getByText('Active').waitFor();
  check('enable → the issued key works again', (await mcp(fay, issued, 'tools/list')).status === 200);
  check('no own-account actions for the admin', (await admin.getByRole('row', { name: /\(you\)/ }).getByRole('button').count()) === 0);
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  check('flow completed', false, e.message.split('\n')[0]);
} finally {
  if (admin) {
    // Every key of this run's member that is still active, whether or not the flow got this far.
    const allKeys = await admin.evaluate(async () => (await fetch('/api/keys?all=1')).json()).catch(() => []);
    for (const k of allKeys) if (k.owner.email === FAY && !k.revokedAt) created.push(k.id);
    for (const id of created) {
      const st = await admin.evaluate(async (i) => (await fetch(`/api/keys/${i}`, { method: 'DELETE' })).status, id);
      check('cleanup: key revoked', st === 204, String(st));
    }
  }
  await browser.close();
}
const failed = results.filter((x) => !x).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
