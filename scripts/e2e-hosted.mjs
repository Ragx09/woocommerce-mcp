#!/usr/bin/env node
// BON-10 (REQ-SO-05) / TC-BON-10-1: an admin adds an MCP server by container image and the platform runs it.
//   1. The reference server (everything-mcp, the image already built for k3d) is re-tagged as an image of an allowed
//      registry (ghcr.io/ragx09/everything-mcp:e2e-<stamp>) and imported into the k3d nodes (no pull needed).
//   2. A disallowed registry and `:latest` are refused by the API.
//   3. POST /api/hosted → Ready; the namespace, Secret, Service and policies exist; the pod is non-root, read-only,
//      token-less and limited; the secret variable reached the pod (everything's get-env tool) but is in no API
//      response, Deployment, Helm values or gateway log.
//   4. Through /mcp: the tools are listed and callable for the admin; members see nothing until the admin allows it, then
//      only the allowed tools; calls are audited under the right user.
//   5. DELETE → the tools are gone on the next request; namespace, Secret, Service, release and registration are gone.
// Needs kubectl, docker and k3d on the machine that runs the cluster. Usage: node scripts/e2e-hosted.mjs
// Env: APP_ORIGIN, K3D_CLUSTER (mcp), KUBECTL_CONTEXT, READY_TIMEOUT_S (360), KEEP=1 keeps the server, SKIP_IMPORT=1 (image already in the cluster).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ensureDemoUsers } from './seed-demo-users.mjs';
import { createKey } from './lib/gateway-key.mjs';

const ORIGIN = process.env.APP_ORIGIN ?? 'http://app.127.0.0.1.nip.io';
const ctx = process.env.KUBECTL_CONTEXT ? ['--context', process.env.KUBECTL_CONTEXT] : [];
const run = (cmd, ...a) => execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const kubectl = (...a) => run('kubectl', ...ctx, ...a);
const kubectlOk = (...a) => { try { return { ok: true, out: kubectl(...a) }; } catch (e) { return { ok: false, out: String(e.stderr ?? e.message) }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = new Date().toISOString().slice(8, 16).replace(/\D/g, '');
const SLUG = 'e2e-every';
const SECRET = `s3cr3t-${randomBytes(9).toString('hex')}`;
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` (${extra})` : ''}`); return ok; };

async function api(method, path, cookie, body) {
  const res = await fetch(`${ORIGIN}${path}`, { method, headers: { origin: ORIGIN, cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}
let rpcId = 0;
const rpc = async (key, method, params) => {
  const res = await fetch(`${ORIGIN}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) }) });
  return { status: res.status, requestId: res.headers.get('x-request-id'), json: await res.json().catch(() => null) };
};
const names = async (key) => ((await rpc(key, 'tools/list')).json?.result?.tools ?? []).map((t) => t.name);

const { a, b } = await ensureDemoUsers();
const admin = await createKey(`e2e-hosted ${stamp}`);
const member = (await api('POST', '/api/keys', b.cookie, { name: `e2e-hosted ${stamp}` })).body;
let hostedId = null;
try {
  // 1. The image, under an allowed registry name.
  const deployed = kubectl('-n', 'platform', 'get', 'deploy', 'everything-mcp', '-o', 'jsonpath={.spec.template.spec.containers[0].image}');
  const image = `ghcr.io/ragx09/everything-mcp:e2e-${stamp}`;
  if (!process.env.SKIP_IMPORT) {
    run('docker', 'tag', deployed, image);
    run('k3d', 'image', 'import', image, '-c', process.env.K3D_CLUSTER ?? 'mcp');
  }
  console.log(`  image ${deployed} → ${image}`);

  // 2. Refusals.
  const listed = (await api('GET', '/api/hosted', a.cookie)).body;
  check('TC-BON-10-1a hosting is enabled with allowed registries', listed?.enabled === true && listed.registries.length > 0, `registries ${listed?.registries?.join(', ')}`);
  const refuse = async (img, code) => { const r = await api('POST', '/api/hosted', a.cookie, { name: 'x', slug: 'refused', image: img, port: 8080 }); return r.status === 400 && r.body?.error === code; };
  check('TC-BON-10-2 docker.io is not an allowed registry', await refuse('docker.io/library/nginx:1.27', 'registry_not_allowed'));
  check('TC-BON-10-2 :latest is refused', await refuse('ghcr.io/ragx09/everything-mcp:latest', 'validation_failed'));
  check('TC-BON-10-2 a member cannot add a hosted server', (await api('POST', '/api/hosted', b.cookie, { name: 'x', slug: 'refused', image, port: 8080 })).status === 403);

  // 3. Add and wait.
  const t0 = Date.now();
  const made = await api('POST', '/api/hosted', a.cookie, { name: 'E2E Everything', slug: SLUG, image, port: 8080, path: '/mcp',
    env: { GZIP_ALLOWED_DOMAINS: 'invalid' }, secretEnv: { E2E_SECRET: SECRET } });
  check('TC-BON-10-1b added (202, provisioning)', made.status === 202 && made.body?.status === 'provisioning', `${made.status} ${made.body?.message ?? ''}`);
  if (made.status !== 202) throw new Error('could not add the server');
  hostedId = made.body.id;
  let state = made.body;
  for (const end = Date.now() + Number(process.env.READY_TIMEOUT_S ?? 360) * 1000; Date.now() < end;) {
    state = (await api('GET', `/api/hosted/${hostedId}`, a.cookie)).body;
    if (state.status === 'ready' || state.status === 'failed') break;
    await sleep(4000);
  }
  check('TC-BON-10-1c Ready', state.status === 'ready', `${state.status}${state.statusReason ? ` (${state.statusReason})` : ''} after ${Math.round((Date.now() - t0) / 1000)} s`);
  if (state.status !== 'ready') throw new Error('server not ready');
  const ns = `hosted-${SLUG}`;
  check('namespace labelled platform.io/hosted with Pod Security restricted', kubectl('get', 'ns', ns, '-o', 'jsonpath={.metadata.labels}').includes('"platform.io/hosted":"e2e-every"') && kubectl('get', 'ns', ns, '-o', 'jsonpath={.metadata.labels.pod-security\\.kubernetes\\.io/enforce}') === 'restricted');
  check('Secret, Service, NetworkPolicies, quota exist in it', ['secret/server-env', 'service/server', 'networkpolicy/default-deny', 'networkpolicy/server-from-gateway', 'resourcequota/hosted'].every((o) => kubectlOk('-n', ns, 'get', o).ok));
  const pod = JSON.parse(kubectl('-n', ns, 'get', 'pod', '-l', 'app=hosted-server', '-o', 'json')).items[0];
  const c = pod.spec.containers[0];
  check('pod: non-root, read-only root filesystem, no capabilities, no token, limits set',
    pod.spec.securityContext.runAsNonRoot === true && pod.spec.securityContext.runAsUser === 10001 && c.securityContext.readOnlyRootFilesystem === true
    && c.securityContext.capabilities.drop.includes('ALL') && pod.spec.automountServiceAccountToken === false && Boolean(c.resources.limits?.memory) && Boolean(c.resources.requests?.cpu));
  check('the secret value is in the Secret only: not in the Deployment, the Helm release values, the API or the gateway logs',
    !kubectl('-n', ns, 'get', 'deploy', 'server', '-o', 'yaml').includes(SECRET)
    && !kubectlOk('-n', ns, 'get', 'secret', '-l', 'owner=helm', '-o', 'yaml').out.includes(Buffer.from(SECRET).toString('base64'))
    && !JSON.stringify((await api('GET', '/api/hosted', a.cookie)).text).includes(SECRET)
    && !kubectl('-n', 'platform', 'logs', '-l', 'app=gateway', '--tail=2000').includes(SECRET)
    && !kubectl('-n', 'platform', 'logs', '-l', 'app=provisioner', '--tail=2000').includes(SECRET));

  // 4. Through the gateway.
  const aNames = await names(admin.key);
  check('TC-BON-10-1d admin tools/list has the hosted server\'s tools', aNames.some((n) => n === `${SLUG}__echo`), `${aNames.filter((n) => n.startsWith(`${SLUG}__`)).length} tools`);
  const echo = await rpc(admin.key, 'tools/call', { name: `${SLUG}__echo`, arguments: { message: 'hello from a hosted server' } });
  check('TC-BON-10-1e a call through /mcp reaches the hosted server', JSON.stringify(echo.json?.result ?? echo.json).includes('hello from a hosted server'));
  const env = await rpc(admin.key, 'tools/call', { name: `${SLUG}__get-env`, arguments: {} });
  check('the secret variable reached the pod\'s environment', JSON.stringify(env.json?.result ?? '').includes(SECRET));
  check('members see none of it by default', !(await names(member.key)).some((n) => n.startsWith(`${SLUG}__`)));
  const up = (await api('GET', '/api/upstreams', a.cookie)).body.find((u) => u.slug === SLUG);
  check('the server is listed with kind hosted', up?.kind === 'hosted');
  check('its address and credentials cannot be edited through /api/upstreams', (await api('PATCH', `/api/upstreams/${up.id}`, a.cookie, { url: 'http://evil.example/mcp' })).status === 409);
  await api('PATCH', `/api/upstreams/${up.id}`, a.cookie, { memberAccess: 'selected', memberTools: ['echo'] });
  const mNames = (await names(member.key)).filter((n) => n.startsWith(`${SLUG}__`));
  check('after the admin allows echo, members get exactly that tool', JSON.stringify(mNames) === JSON.stringify([`${SLUG}__echo`]), mNames.join(', '));
  const forbidden = await rpc(member.key, 'tools/call', { name: `${SLUG}__get-env`, arguments: {} });
  check('and are refused the rest', forbidden.json?.error?.data?.code === 'tool_forbidden');
  const audit = (await api('GET', `/api/audit?upstream=${SLUG}&limit=50`, a.cookie)).body;
  check('calls are audited under the right users', audit.items.some((r) => r.tool === 'echo' && r.user?.id === a.user.id && r.outcome === 'ok') && audit.items.some((r) => r.errorCode === 'tool_forbidden' && r.user?.id === b.user.id));
} finally {
  if (hostedId && !process.env.KEEP) {
    const del = await api('DELETE', `/api/hosted/${hostedId}?confirm=${SLUG}`, a.cookie);
    check('TC-BON-10-1f delete accepted', del.status === 202, `${del.status}`);
    check('its tools are gone on the very next request', !(await names(admin.key)).some((n) => n.startsWith(`${SLUG}__`)));
    check('/api/upstreams no longer lists it', !(await api('GET', '/api/upstreams', a.cookie)).body.some((u) => u.slug === SLUG));
    for (const end = Date.now() + 240_000; Date.now() < end && (await api('GET', `/api/hosted/${hostedId}`, a.cookie)).status !== 404;) await sleep(4000);
    check('removed from the hosted list', (await api('GET', `/api/hosted/${hostedId}`, a.cookie)).status === 404);
    check('kubectl: namespace gone', !kubectlOk('get', 'ns', `hosted-${SLUG}`).ok);
    check('kubectl: no Secret or Helm release record left', kubectl('get', 'secret', '-A', '-o', 'name', '--field-selector', `metadata.namespace=hosted-${SLUG}`) === '');
  } else if (hostedId) console.log(`KEEP=1: hosted server ${SLUG} left in place`);
  await api('DELETE', `/api/keys/${admin.id}`, admin.cookie).catch(() => {});
  if (member?.id) await api('DELETE', `/api/keys/${member.id}`, b.cookie).catch(() => {});
}
const failed = results.filter((x) => !x).length;
console.log(failed ? `\nFAIL  BON-10 hosted servers (${failed} of ${results.length})` : `\nPASS  BON-10 hosted servers (${results.length}/${results.length})`);
process.exit(failed ? 1 : 0);
