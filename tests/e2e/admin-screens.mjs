// BRD-08: TATVA admin colour scheme and login page. Screenshots + computed-style checks.
// Run: scripts/admin-screens.sh   (Playwright in Docker; ADMIN_PASSWORD comes from the K8s Secret, never printed)
import { chromium } from 'playwright';

const STORE = process.env.STORE_URL ?? 'http://store.127.0.0.1.nip.io';
const USER = process.env.ADMIN_USER ?? 'admin';
const PASS = process.env.ADMIN_PASSWORD;
if (!PASS) throw new Error('ADMIN_PASSWORD not set');
const fails = [];
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) fails.push(name); };

const browser = await chromium.launch();
for (const [vp, size] of Object.entries({ desktop: { width: 1366, height: 900 }, mobile: { width: 390, height: 844 } })) {
  const page = await browser.newPage({ viewport: size });
  // TC-BRD-08-2: login page
  await page.goto(`${STORE}/wp-login.php`, { waitUntil: 'networkidle' });
  const login = await page.evaluate(() => {
    const a = document.querySelector('#login h1 a');
    return { bg: getComputedStyle(a).backgroundImage, href: a.href, text: a.textContent.trim(), body: getComputedStyle(document.body).backgroundColor,
      btn: getComputedStyle(document.querySelector('#wp-submit')).backgroundColor };
  });
  const svg = login.bg.match(/url\("?([^")]+)"?\)/)?.[1];
  const svgStatus = svg ? (await page.request.get(svg)).status() : 0;
  check(`${vp} login logo is the TATVA wordmark`, /tatva-wordmark\.svg/.test(login.bg) && svgStatus === 200, `${svg?.replace(STORE, '')} → ${svgStatus}`);
  check(`${vp} login logo links to the store`, login.href === `${STORE}/`, `${login.href} "${login.text}"`);
  check(`${vp} login colours`, login.body === 'rgb(248, 246, 240)' && login.btn === 'rgb(23, 61, 53)', `body ${login.body}, button ${login.btn}`);
  await page.screenshot({ path: `/out/admin-${vp}-login.png`, fullPage: true });

  await page.fill('#user_login', USER);
  await page.fill('#user_pass', PASS);
  await Promise.all([page.waitForURL(/wp-admin/), page.click('#wp-submit')]);
  // TC-BRD-08-1: wp-admin with the TATVA scheme
  await page.goto(`${STORE}/wp-admin/`, { waitUntil: 'networkidle' });
  if (vp === 'mobile') await page.click('#wp-admin-bar-menu-toggle a').catch(() => {});
  const admin = await page.evaluate(() => ({
    scheme: [...document.querySelectorAll('link[rel=stylesheet]')].some((l) => l.href.includes('tatva/assets/css/admin-colors.css')),
    bodyClass: document.body.className.match(/admin-color-\S+/)?.[0],
    menu: getComputedStyle(document.querySelector('#adminmenuwrap')).backgroundColor,
    current: getComputedStyle(document.querySelector('#adminmenu li.current a.menu-top, #adminmenu li.wp-has-current-submenu a.wp-has-current-submenu')).backgroundColor,
    bar: getComputedStyle(document.querySelector('#wpadminbar')).backgroundColor,
    hScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
  check(`${vp} admin scheme stylesheet loaded`, admin.scheme && admin.bodyClass === 'admin-color-tatva', admin.bodyClass);
  check(`${vp} admin menu colours`, admin.menu === 'rgb(23, 61, 53)' && admin.current === 'rgb(232, 220, 201)' && admin.bar === 'rgb(15, 44, 38)',
    `menu ${admin.menu}, current ${admin.current}, bar ${admin.bar}`);
  await page.screenshot({ path: `/out/admin-${vp}-dashboard.png` });
  if (vp === 'desktop') {
    await page.goto(`${STORE}/wp-admin/edit.php?post_type=product`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: `/out/admin-${vp}-products.png` });
    await page.goto(`${STORE}/wp-admin/profile.php`, { waitUntil: 'networkidle' });
    const offered = await page.locator('input[name=admin_color][value=tatva]').count();
    const others = await page.locator('input[name=admin_color]').count();
    check('profile offers TATVA among the schemes', offered === 1 && others > 1, `${others} schemes`);
  }
  await page.close();
}
await browser.close();
console.log(fails.length ? `${fails.length} FAILED` : 'all checks passed');
process.exitCode = fails.length ? 1 : 0;
