// TC-UI-18-1: chat error states in a real browser against the cluster.
// 1. Stubbed /api/chat answers (no LLM tokens): failed tool calls for an unreachable server, a timeout, a
//    disabled server and a tool's own error each show a readable line; the raw text stays in the card.
// 2. Real LLM, one question: the host has scaled woo-mcp to 0 before this runs. Once the Servers API
//    shows woo as unreachable, "What orders came in today?" must give a readable notice naming the woo
//    server, not a stack trace or a silent "no tools". Phone width checked too. Creates no data.
import { chromium } from 'playwright';

const APP = process.env.APP_URL ?? 'http://app.127.0.0.1.nip.io';
const OUT = '/out';
const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` (${extra})` : ''}`); };

const browser = await chromium.launch();
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errors.push(String(e)));
p.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) errors.push(m.text()); });

await p.goto(`${APP}/login?next=${encodeURIComponent('/chat')}`);
await p.getByLabel('Email').fill(ADMIN_EMAIL);
await p.getByLabel('Password').fill(ADMIN_PASSWORD);
await p.getByRole('button', { name: 'Sign in' }).click();
await p.waitForURL(`${APP}/chat`);

// 1. Stubbed failures.
const call = (name, server, resultPreview) => ({ name, server, args: {}, ok: false, ms: 5, resultPreview });
await p.route('**/api/chat', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
  reply: 'Some tools failed.', stopped: 'answer', unavailable: [],
  toolCalls: [
    call('woo__list_orders', 'woo', 'upstream_unreachable: upstream woo unreachable: connect ECONNREFUSED 10.43.1.2:3000'),
    call('github__search_issues', 'github', 'upstream_timeout: upstream github did not answer within 15 s'),
    call('everything__echo', 'everything', 'MCP error -32602: upstream everything is disabled'),
    call('woo__get_order', 'woo', 'order 999 not found'),
  ] }) }));
await p.getByLabel('Message').fill('stubbed failures');
await p.getByLabel('Message').press('Enter');
const turn = p.locator('.turn.assistant').last();
await turn.locator('.bubble').waitFor();
const cards = turn.locator('details.toolcall.failed');
const summaries = await cards.locator('summary').allTextContents();
check('4 failed cards', summaries.length === 4, String(summaries.length));
check('unreachable card: badge + readable line', /unreachable/.test(summaries[0]) && /woo server could not be reached/.test(summaries[0]));
check('timeout card: badge + seconds', /timed out/.test(summaries[1]) && /did not answer in time \(15 s\)/.test(summaries[1]));
check('disabled card explained', /disabled/.test(summaries[2]) && /turned off by an admin/.test(summaries[2]));
check("tool's own error stays a plain error", /^.*error/.test(summaries[3]) && /tool reported an error/.test(summaries[3]));
const note = await turn.locator('.notice').textContent();
check('summary above the answer, one line per server problem, no tool error', /woo server could not be reached/.test(note)
  && /github server did not answer/.test(note) && /turned off/.test(note) && !/tool reported/.test(note) && /may be incomplete/.test(note));
check('raw detail not in the visible summary', !note.includes('10.43') && !note.includes('ECONNREFUSED'));
await cards.first().locator('summary').click();
check('raw detail still in the expanded card', (await cards.first().locator('pre').last().textContent()).includes('ECONNREFUSED'));
await p.screenshot({ path: `${OUT}/ui18-tool-errors.png`, fullPage: true });
await p.setViewportSize({ width: 390, height: 844 });
check('phone width: no horizontal scroll', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
await p.screenshot({ path: `${OUT}/ui18-tool-errors-phone.png`, fullPage: true });
await p.setViewportSize({ width: 1280, height: 900 });
await p.unroute('**/api/chat');
await p.getByRole('button', { name: 'New chat' }).click();

// 2. Real: woo-mcp is down (scaled to 0 by the host). Wait until the gateway has noticed.
let status = '';
for (let i = 0; i < 40 && status !== 'unreachable'; i++) {
  const list = await p.evaluate(async () => (await fetch('/api/upstreams')).json());
  status = (Array.isArray(list) ? list : list.items ?? []).find((u) => u.slug === 'woo')?.status ?? '?';
  if (status !== 'unreachable') await p.waitForTimeout(1000);
}
check('gateway sees woo as unreachable', status === 'unreachable', status);
const resp = p.waitForResponse((r) => r.url().endsWith('/api/chat') && r.request().method() === 'POST', { timeout: 160_000 });
await p.getByLabel('Message').fill('What orders came in today?');
await p.getByRole('button', { name: 'Send' }).click();
const r = await resp;
const body = await r.json().catch(() => ({}));
check('POST /api/chat 200', r.status() === 200, `HTTP ${r.status()}${body.error ? ` ${body.error}` : ''}`);
if (r.status() === 200) {
  check('response lists woo as unavailable', (body.unavailable ?? []).some((u) => u.server === 'woo'), JSON.stringify(body.unavailable));
  const answer = p.locator('.turn.assistant').last();
  await answer.locator('.bubble').waitFor();
  const n = await answer.locator('.notice').textContent();
  check('readable notice naming the woo server', /woo server .*could not be reached/.test(n), n.trim().slice(0, 140));
  const reply = await answer.locator('.bubble').textContent();
  console.log(`      model reply: ${reply.replace(/\s+/g, ' ').slice(0, 200)}`);
  check('reply has no stack trace or internal address', !/at .+\(.+:\d+:\d+\)|10\.43\.|ECONNREFUSED/.test(reply + n));
  await p.screenshot({ path: `${OUT}/ui18-woo-down.png`, fullPage: true });
}
check('no page errors / CSP violations', errors.length === 0, errors.join(' | '));

await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`\nchat-errors: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
