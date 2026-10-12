// WC-04 / TC-E2E-12: a guest buys a product on the storefront with Cash on delivery, in a real browser.
// Run: scripts/e2e-checkout.sh   (Playwright in Docker; STORE_URL defaults to http://store.127.0.0.1.nip.io)
import { chromium } from 'playwright';

const STORE = process.env.STORE_URL ?? 'http://store.127.0.0.1.nip.io';
const PRODUCT = process.env.PRODUCT_SLUG ?? 'hand-finished-stoneware-mug';
const browser = await chromium.launch();
const page = await browser.newPage();
page.setDefaultTimeout(30_000);
try {
  await page.goto(`${STORE}/product/${PRODUCT}/`);
  await page.getByRole('button', { name: /add to cart/i }).first().click();
  await page.waitForLoadState('networkidle');
  await page.goto(`${STORE}/checkout/`);
  await page.getByLabel(/email address/i).fill('buyer@example.test');
  // Store base country is India (TATVA): Indian address, state and PIN code.
  await page.getByLabel(/^first name/i).fill('Asha');
  await page.getByLabel(/^last name/i).fill('Rao');
  await page.getByLabel(/^address$/i).fill('12 Demo Road');
  await page.getByLabel(/^city/i).fill('Bengaluru');
  const state = page.getByLabel(/^state/i).first();
  if (await state.evaluate((el) => el.tagName === 'SELECT')) await state.selectOption({ label: 'Karnataka' });
  else { await state.fill('Karnataka'); await page.getByRole('option', { name: 'Karnataka' }).first().click().catch(() => {}); }
  const zip = page.getByLabel(/pin code|zip code|postcode|postal code/i).first();
  await zip.fill('560001');
  await page.screenshot({ path: '/out/checkout-form.png', fullPage: true });
  await expectText(page, 'Cash on delivery');
  await page.getByRole('button', { name: /place order/i }).click();
  await page.waitForURL(/order-received/, { timeout: 60_000 });
  const orderId = new URL(page.url()).pathname.match(/order-received\/(\d+)/)?.[1];
  await page.screenshot({ path: '/out/order-received.png', fullPage: true });
  console.log(`PASS  order placed: #${orderId} (${page.url().replace(/key=[^&]+/, 'key=…')})`);
} catch (e) {
  await page.screenshot({ path: '/out/checkout-failure.png', fullPage: true }).catch(() => {});
  console.error(`FAIL  ${e.message.split('\n')[0]}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
async function expectText(p, text) {
  if (!(await p.getByText(text).first().isVisible())) throw new Error(`"${text}" not visible on checkout`);
}
