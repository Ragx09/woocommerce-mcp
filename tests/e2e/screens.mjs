// BRD-07: storefront screenshots (desktop + mobile) and a broken-image / console-error audit.
// Run: scripts/storefront-screens.sh   (Playwright in Docker, writes PNGs to tests/e2e/out/screens)
import { chromium } from 'playwright';

const STORE = process.env.STORE_URL ?? 'http://store.127.0.0.1.nip.io';
const PAGES = (process.env.PAGES || '/,/shop/,/product/hand-finished-stoneware-mug/,/brands/,/brand/mitti-and-form/,/categories/,/product-category/home-living/,/our-concept/,/?s=mug&post_type=product,/?s=zzzz&post_type=product,/cart/').split(',');
const VIEWPORTS = { desktop: { width: 1366, height: 900 }, mobile: { width: 390, height: 844 } };
const browser = await chromium.launch();
let problems = 0;
for (const [vp, size] of Object.entries(VIEWPORTS)) {
  const page = await browser.newPage({ viewport: size });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url().replace(STORE, '').slice(0, 140)}`); });
  for (const path of PAGES) {
    errors.length = 0;
    const res = await page.goto(STORE + path, { waitUntil: 'networkidle' });
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } window.scrollTo(0, 0); });
    await page.waitForTimeout(400);
    const audit = await page.evaluate(() => ({
      broken: [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && i.getAttribute('src')).map((i) => i.getAttribute('src')),
      noAlt: [...document.images].filter((i) => !i.hasAttribute('alt')).length,
      fallbacks: document.querySelectorAll('.tatva-img-fallback').length,
      hScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
      title: document.title,
    }));
    const name = `${vp}-${path.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home'}`;
    await page.screenshot({ path: `/out/${name}.png`, fullPage: true });
    const bad = res.status() >= 400 || audit.broken.length || audit.hScroll || errors.length;
    if (bad) problems++;
    console.log(`${bad ? 'WARN' : 'OK  '} ${vp} ${path} → ${res.status()} "${audit.title}" broken=${audit.broken.length} fallbacks=${audit.fallbacks} noAlt=${audit.noAlt} hScroll=${audit.hScroll} consoleErrors=${errors.length}${errors.length ? ' ' + JSON.stringify(errors.slice(0, 4)) : ''}`);
  }
  await page.close();
}
await browser.close();
process.exitCode = problems ? 1 : 0;
