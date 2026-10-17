// UI-19 (TC-E2E-03, browser part): the DoD prompt typed into the dashboard Chat page with the real LLM. The
// answer shows an ok woo__create_product card, the product link in the reply opens the live storefront page
// at the asked price. One LLM question; creates one product "Demo Mug <stamp>" (kept, like a demo would).
import { chromium } from 'playwright';

const APP = process.env.APP_URL ?? 'http://app.127.0.0.1.nip.io';
const OUT = '/out';
const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
const NAME = `Demo Mug ${new Date().toISOString().slice(5, 16).replace(/\D/g, '')}`;
const PRICE = process.env.PRICE ?? '499';
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` (${extra})` : ''}`); };

const browser = await chromium.launch();
const errors = [];
const p = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
p.on('pageerror', (e) => errors.push(String(e)));
p.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) errors.push(m.text()); });

await p.goto(`${APP}/login?next=${encodeURIComponent('/chat')}`);
await p.getByLabel('Email').fill(ADMIN_EMAIL);
await p.getByLabel('Password').fill(ADMIN_PASSWORD);
await p.getByRole('button', { name: 'Sign in' }).click();
await p.waitForURL(`${APP}/chat`);

await p.getByLabel('Message').fill(`Create a product called ${NAME} priced ${PRICE}`);
const resp = p.waitForResponse((r) => r.url().endsWith('/api/chat') && r.request().method() === 'POST', { timeout: 160_000 });
await p.getByRole('button', { name: 'Send' }).click();
const r = await resp;
const body = await r.json();
check('POST /api/chat 200', r.status() === 200, `HTTP ${r.status()}${body.error ? ` ${body.error}` : ''}`);
if (r.status() === 200) {
  const answer = p.locator('.turn.assistant').last();
  await answer.locator('.bubble').waitFor();
  const card = answer.locator('details.toolcall', { hasText: 'create_product' });
  check('an ok create_product card', await card.count() === 1 && /ok/.test(await card.locator('summary').textContent()));
  await card.locator('summary').click();
  const inner = await card.locator('.toolcall-body').innerText();
  check('card shows the name and price arguments', inner.includes(NAME) && inner.includes(`"regular_price": "${PRICE}"`));
  check('reply names the product', (await answer.locator('.bubble').textContent()).includes(NAME));
  await p.screenshot({ path: `${OUT}/ui19-chat-create.png`, fullPage: true });
  const call = body.toolCalls.find((c) => c.name === 'woo__create_product' && c.ok);
  const permalink = call && JSON.parse(call.resultPreview).permalink;
  if (permalink) {
    // The container reaches the storefront by its public host name (host-gateway, like checkout.mjs).
    const store = await p.context().newPage();
    const res = await store.goto(permalink);
    const title = await store.locator('h1').first().textContent();
    const price = (await store.locator('.summary .price, .wc-block-components-product-price').first().textContent()).replace(/\s/g, '');
    check('the product page is live on the storefront at the asked price', res.status() === 200 && title.includes(NAME) && price === `₹${PRICE}`, `${res.status()} "${title.trim()}" ${price}`);
    await store.screenshot({ path: `${OUT}/ui19-storefront-product.png`, fullPage: false });
  } else check('tool result has a permalink', false);
}
check('no page errors / CSP violations', errors.length === 0, errors.join(' | '));
await browser.close();
const failed = results.filter((x) => !x).length;
console.log(failed ? `FAIL  UI-19 browser (${failed} of ${results.length})` : `PASS  UI-19 browser (${results.length}/${results.length}): ${NAME}`);
process.exit(failed ? 1 : 0);
