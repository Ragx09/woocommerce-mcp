// BON-10 browser check on a real cluster: Servers → Hosted servers → Add by image. Refusals in the form, Creating… → Ready,
// only the secret variable's name is shown, the pods/quota line (admin), the hosted badge in the servers list, delete with
// the slug typed back. The image is the already-built everything-mcp, re-tagged as an allowed-registry name and imported into
// the k3d nodes by scripts/dashboard-screens.sh (HOSTED_IMAGE). Admin only.
import { chromium } from 'playwright';

const APP = process.env.APP_URL ?? 'http://app.127.0.0.1.nip.io';
const OUT = '/out';
const { ADMIN_EMAIL, ADMIN_PASSWORD, HOSTED_IMAGE } = process.env;
const SECRET = `ui-secret-${Math.random().toString(36).slice(2)}`;
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` (${extra})` : ''}`); return ok; };
if (!HOSTED_IMAGE) { console.error('HOSTED_IMAGE is required (run via scripts/dashboard-screens.sh hosted)'); process.exit(2); }

const browser = await chromium.launch();
const errors = [];
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
page.on('pageerror', (e) => errors.push(String(e)));
const json = (method, url) => page.evaluate(async ([m, u]) => { const r = await fetch(u, { method: m }); return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }; }, [method, url]);
let id = null;
try {
  await page.goto(`${APP}/login?next=/servers`);
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${APP}/servers`);
  await page.getByRole('heading', { name: 'Hosted servers' }).waitFor();
  const fill = async (name, image, extra = {}) => {
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByRole('textbox', { name: /^Image/ }).fill(image);
    await page.getByLabel('Port').fill('8080');
    await page.getByLabel(/^Environment/).fill(extra.env ?? '');
    await page.getByLabel(/^Secret environment/).fill(extra.secret ?? '');
    await page.getByRole('button', { name: 'Add server' }).click();
  };
  await fill('Ui Hosted', 'docker.io/library/nginx:1.27');
  await page.getByRole('alert').filter({ hasText: /registry not allowed/ }).waitFor();
  check('an image from a registry that is not allowed is refused, with the allowed list', true);
  await fill('Ui Hosted', `${HOSTED_IMAGE.replace(/:[^:/]+$/, '')}:latest`);
  await page.getByRole('alert').filter({ hasText: /not :latest/ }).waitFor();
  check(':latest is refused', true);
  await fill('Ui Hosted', HOSTED_IMAGE, { env: 'GZIP_ALLOWED_DOMAINS=invalid', secret: `E2E_SECRET=${SECRET}` });
  const card = page.locator('article', { hasText: 'Ui Hosted' }).filter({ has: page.locator('code', { hasText: HOSTED_IMAGE }) });
  await card.getByText('Creating…').waitFor();
  const t0 = Date.now();
  await card.getByText('Ready', { exact: true }).waitFor({ timeout: 360_000 });
  check('Creating… → Ready without a reload', true, `${Math.round((Date.now() - t0) / 1000)} s`);
  id = (await json('GET', '/api/hosted')).body.servers.find((s) => s.slug === 'ui-hosted')?.id ?? null;
  check('only the secret variable NAME is shown, never its value', (await card.getByText('E2E_SECRET').count()) > 0 && !(await page.content()).includes(SECRET));
  check('egress is off by default', (await card.getByText('no outbound network').count()) > 0);
  await card.getByLabel('Runtime').waitFor({ timeout: 120_000 });
  check('the admin sees pods and quota for it', /Pods 1\/1 ready/.test(await card.getByLabel('Runtime').innerText()));
  await page.locator('span.badge', { hasText: 'hosted' }).waitFor({ timeout: 30_000 });
  check('it appears in the servers list with a hosted badge', true);
  await page.screenshot({ path: `${OUT}/bon-10-hosted-ready.png`, fullPage: true });
  await card.getByRole('button', { name: 'Delete…' }).click();
  const del = card.getByRole('button', { name: 'Delete server' });
  check('delete is disabled until the slug is typed', await del.isDisabled());
  await card.getByPlaceholder('ui-hosted').fill('ui-hosted');
  await del.click();
  await page.waitForFunction(() => !document.body.innerText.includes('Ui Hosted'), null, { timeout: 240_000 });
  id = null;
  const left = (await json('GET', '/api/upstreams')).body.filter((u) => u.slug === 'ui-hosted');
  check('server and registration are gone', left.length === 0);
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('script completed', false, String(e.message ?? e).slice(0, 300));
} finally {
  if (id) await json('DELETE', `/api/hosted/${id}?confirm=ui-hosted`).catch(() => {});
  await browser.close();
}
const failed = results.filter((x) => !x).length;
console.log(failed ? `\nFAIL  BON-10 hosted page (${failed} of ${results.length})` : `\nPASS  BON-10 hosted page (${results.length}/${results.length})`);
process.exit(failed ? 1 : 0);
