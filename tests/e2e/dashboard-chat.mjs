// TC-UI-16-1: the chat page in a real browser against the cluster, with the real LLM (one question, to stay
// within the Groq free tier). The admin asks about today's orders, moves to another page while the answer
// is on its way and comes back; the answer shows its tool calls as collapsible cards (tool, server,
// arguments, result excerpt, ms, ok/error) and the same calls are in the audit log as source=chat under
// the admin. Error states (LLM rate limit, chat disabled) are checked with a stubbed /api/chat response so
// they cost no LLM tokens. Phone width, no page errors and no CSP violations. Creates no data.
import { chromium } from 'playwright';

const APP = process.env.APP_URL ?? 'http://app.127.0.0.1.nip.io';
const OUT = '/out';
const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
const QUESTION = 'What orders came in today? Give the count and total.';
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
check('chat page reachable from the nav', await p.getByRole('link', { name: 'Chat' }).isVisible());
check('empty chat offers suggestions', await p.getByRole('button', { name: 'What orders came in today?' }).isVisible());
await p.screenshot({ path: `${OUT}/ui16-chat-empty.png`, fullPage: true });

// 1. Error states, stubbed (no LLM call).
await p.route('**/api/chat', (r) => r.fulfill({ status: 429, contentType: 'application/json', headers: { 'retry-after': '3' },
  body: JSON.stringify({ error: 'llm_rate_limited', message: 'provider says slow down' }) }));
await p.getByLabel('Message').fill('stubbed question');
await p.getByLabel('Message').press('Enter');
const alert = p.getByRole('alert');
await alert.waitFor();
check('LLM rate limit → readable error with the wait time', /rate limit.*retry in [1-3] s/.test(await alert.textContent()), await alert.textContent());
// UI-18: sending is blocked during the provider's wait, then allowed again.
check('Send blocked while waiting', await p.getByRole('button', { name: /^Wait \d+ s$/ }).isDisabled());
await p.getByRole('button', { name: 'Retry', exact: true }).waitFor({ timeout: 6_000 });
check('rate-limit wait over → Retry offered', /has reset/.test(await alert.textContent()));
check('failed question goes back to the input, not into the transcript',
  (await p.getByLabel('Message').inputValue()) === 'stubbed question' && (await p.locator('.turn.user').count()) === 0);
await p.unroute('**/api/chat');
await p.route('**/api/chat', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'chat_disabled', message: 'x' }) }));
await p.getByRole('button', { name: 'Send' }).click();
await p.waitForFunction(() => /not set up/.test(document.querySelector('[role=alert]')?.textContent ?? ''));
check('chat disabled → explained', true);
await p.unroute('**/api/chat');
// A stubbed answer: Markdown is drawn, HTML from the model stays text, a failed call is marked.
await p.route('**/api/chat', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
  reply: '**Bold part** and `code`\n- item <img src=x onerror="window.__xss=1">', stopped: 'max_steps',
  toolCalls: [{ name: 'woo__get_order', server: 'woo', args: { id: 999 }, ok: false, ms: 12, resultPreview: 'order 999 not found' }] }) }));
await p.getByRole('button', { name: 'Send' }).click();
const stub = p.locator('.turn.assistant').last();
await stub.locator('.bubble').waitFor();
check('Markdown subset rendered, HTML not', await stub.locator('.bubble strong').textContent() === 'Bold part'
  && await stub.locator('.bubble img').count() === 0 && (await stub.locator('.bubble').textContent()).includes('<img')
  && await p.evaluate(() => window.__xss === undefined));
check('failed tool call marked, stop reason shown', /error/.test(await stub.locator('details.toolcall.failed summary').textContent())
  && /1 failed/.test(await stub.textContent()) && /too many tool rounds/.test(await stub.textContent()));
await p.unroute('**/api/chat');
await p.getByRole('button', { name: 'New chat' }).click();

// 2. Real question; leave the page while it runs and come back.
const started = new Date().toISOString();
await p.getByLabel('Message').fill(QUESTION);
const resp = p.waitForResponse((r) => r.url().endsWith('/api/chat') && r.request().method() === 'POST', { timeout: 160_000 });
await p.getByRole('button', { name: 'Send' }).click();
check('question shown at once with a progress line', await p.locator('.turn.user .bubble', { hasText: QUESTION }).isVisible()
  && await p.getByRole('status').filter({ hasText: 'Working on it' }).isVisible());
await p.getByRole('link', { name: 'API keys' }).click();
await p.waitForURL(`${APP}/keys`);
const r = await resp;
const body = await r.json();
await p.getByRole('link', { name: 'Chat' }).click();
await p.waitForURL(`${APP}/chat`);
check('POST /api/chat 200', r.status() === 200, `HTTP ${r.status()}${body.error ? ` ${body.error}` : ''}`);
if (r.status() !== 200) console.log(`      request body: ${r.request().postData()}`);
if (r.status() === 200) {
  const answer = p.locator('.turn.assistant').last();
  await answer.locator('.bubble').waitFor();
  const plain = (t) => t.replace(/[*`#•\-\s]/g, ''); // the bubble draws the Markdown markers
  check('answer survived navigating away and back', plain(await answer.locator('.bubble').textContent()) === plain(body.reply));
  const cards = answer.locator('details.toolcall');
  const n = await cards.count();
  check('one card per tool call', n === body.toolCalls.length && n > 0, `${n} cards, ${body.toolCalls.length} calls`);
  const woo = body.toolCalls.findIndex((c) => c.server === 'woo');
  check('a WooCommerce tool was called', woo >= 0, body.toolCalls.map((c) => c.name).join(', '));
  if (woo >= 0) {
    const c = body.toolCalls[woo];
    const card = cards.nth(woo);
    const summary = await card.locator('summary').textContent();
    check('collapsed card shows tool, server, ms and status', !(await card.evaluate((d) => d.open))
      && summary.includes(c.name.replace(/^woo__/, '')) && summary.includes('woo') && summary.includes(`${c.ms} ms`) && /ok|error/.test(summary), summary);
    await card.locator('summary').click();
    const inner = await card.locator('.toolcall-body').innerText();
    check('expanded card shows full name, arguments and result excerpt', await card.evaluate((d) => d.open) && inner.includes(c.name)
      && /Arguments/.test(inner) && /(Result|Error) \(excerpt\)/.test(inner)
      && (Object.keys(c.args ?? {}).length === 0 || inner.includes(Object.keys(c.args)[0])));
  }
  await p.screenshot({ path: `${OUT}/ui16-chat-answer.png`, fullPage: true });

  // The same calls in the audit log, under the admin, source=chat.
  const audit = await p.evaluate(async (from) => {
    const me = await (await fetch('/api/me')).json();
    const a = await (await fetch(`/api/audit?source=chat&from=${encodeURIComponent(from)}&limit=100`)).json();
    return { me: me.id, rows: a.items.filter((x) => x.method === 'tools/call').map((x) => ({ user: x.user?.id, tool: x.tool, upstream: x.upstream })) };
  }, started);
  const viaGateway = body.toolCalls.filter((c) => c.server);
  check('audit has every gateway tool call under the admin with source=chat',
    audit.rows.length >= viaGateway.length && audit.rows.every((x) => x.user === audit.me), `${audit.rows.length} rows, ${viaGateway.length} calls`);

  // Phone width.
  await p.setViewportSize({ width: 390, height: 844 });
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('phone width: no horizontal scroll', overflow <= 0, `overflow ${overflow}px`);
  await p.screenshot({ path: `${OUT}/ui16-chat-phone.png`, fullPage: true });
  await p.setViewportSize({ width: 1280, height: 900 });

  // New chat clears; signing out clears too (nothing kept in browser storage).
  await p.getByRole('button', { name: 'New chat' }).click();
  check('New chat empties the conversation', (await p.locator('.turn').count()) === 0);
  const stored = await p.evaluate(() => JSON.stringify(localStorage).length + JSON.stringify(sessionStorage).length);
  check('nothing stored in browser storage', stored <= 4, `${stored} bytes`);
}
check('no page errors / CSP violations', errors.length === 0, errors.join(' | '));
await browser.close();
const failed = results.filter((x) => !x).length;
console.log(failed ? `FAIL  TC-UI-16-1 (${failed} of ${results.length})` : `PASS  TC-UI-16-1 (${results.length}/${results.length})`);
process.exit(failed ? 1 : 0);
