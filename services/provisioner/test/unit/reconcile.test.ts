// TC-BON-09-U1..U6: the reconcile steps with fake Kubernetes, Helm and gateway. The k3d tests (TC-BON-09-1/2)
// prove the same against the real API server and RBAC.
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { Helm, ReleaseStatus } from '../../src/helm.js';
import type { Kube } from '../../src/kube.js';
import { Reconciler, type Gateway, type StoreRow } from '../../src/reconcile.js';
import * as gw from '../../../gateway/src/stores/signing.js';
import * as pv from '../../src/signing.js';

class FakeKube implements Kube {
  objects = new Map<string, Record<string, unknown>>();
  creates: string[] = [];
  async get(path: string) {
    if (path.includes('/jobs?')) {
      const ns = /namespaces\/([^/]+)\//.exec(path)![1]!;
      return { items: [...this.objects.entries()].filter(([k]) => k.startsWith(`/apis/batch/v1/namespaces/${ns}/jobs/`)).map(([, v]) => v) };
    }
    return this.objects.get(path) ?? null;
  }
  async create(path: string, body: Record<string, unknown>) {
    const name = (body.metadata as { name: string }).name;
    const key = `${path}/${name}`;
    this.creates.push(key);
    if (this.objects.has(key)) return 'exists' as const;
    this.objects.set(key, body);
    return 'created' as const;
  }
  async remove(path: string) {
    if (!this.objects.has(path)) return 'absent' as const;
    this.objects.set(path, { ...this.objects.get(path), status: { phase: 'Terminating' } });
    return 'deleted' as const;
  }
  /** What the store chart's pods would do once installed. */
  becomeReady(ns: string, jobFailed = false) {
    this.objects.set(`/apis/batch/v1/namespaces/${ns}/jobs/wp-init-1`, { status: jobFailed ? { conditions: [{ type: 'Failed', status: 'True' }] } : { succeeded: 1 } });
    this.objects.set(`/apis/apps/v1/namespaces/${ns}/statefulsets/mariadb`, { status: { readyReplicas: 1 } });
    for (const d of ['wordpress', 'woo-mcp']) this.objects.set(`/apis/apps/v1/namespaces/${ns}/deployments/${d}`, { status: { availableReplicas: 1 } });
  }
}

class FakeHelm implements Helm {
  releases = new Map<string, ReleaseStatus>();
  calls: string[] = [];
  values: Record<string, unknown>[] = [];
  async status(release: string) { return this.releases.get(release) ?? null; }
  async install(release: string, _ns: string, values: object) { this.calls.push(`install ${release}`); this.values.push(values as Record<string, unknown>); this.releases.set(release, 'deployed'); }
  async uninstall(release: string) { this.calls.push(`uninstall ${release}`); this.releases.delete(release); }
}

class FakeGateway implements Gateway {
  events: unknown[] = [];
  async ready(id: string, b: object) { this.events.push(['ready', id, b]); }
  async failed(id: string, reason: string) { this.events.push(['failed', id, reason]); }
  async deleted(id: string) { this.events.push(['deleted', id]); }
}

const row = (over: Partial<StoreRow> = {}): StoreRow => ({ id: '11111111-1111-4111-8111-111111111111', slug: 'tea', name: 'Chai Corner', tagline: 'Fresh leaves',
  niche: 'tea-coffee', nicheText: null, status: 'provisioning', desired: 'present', createdAt: new Date(), ...over });
const setup = (now = Date.now()) => {
  const kube = new FakeKube(); const helm = new FakeHelm(); const gateway = new FakeGateway();
  const mk = () => new Reconciler({ kube, helm, gateway, log: pino({ level: 'silent' }), timeoutMs: 15 * 60_000, now: () => now,
    baseValues: { global: { domain: 'example.test' }, gatewayNamespace: 'platform', init: { brand: { enabled: true } }, quota: { enabled: true } },
    serviceAccount: { name: 'provisioner', namespace: 'platform' } });
  return { kube, helm, gateway, mk };
};

describe('TC-BON-09-U1 provision', () => {
  it('labelled namespace, RoleBinding to store-manager only, four Secrets, one Helm install, then ready with its own woo-mcp', async () => {
    const { kube, helm, gateway, mk } = setup();
    const r = mk();
    await r.pass([row()]);
    const ns = kube.objects.get('/api/v1/namespaces/store-tea')!;
    expect((ns.metadata as { labels: Record<string, string> }).labels).toMatchObject({ 'platform.io/store': 'tea', 'pod-security.kubernetes.io/enforce': 'restricted' });
    const rb = kube.objects.get('/apis/rbac.authorization.k8s.io/v1/namespaces/store-tea/rolebindings/provisioner-store-manager')!;
    expect(rb.roleRef).toEqual({ apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'store-manager' });
    expect([...kube.objects.keys()].filter((k) => k.includes('/secrets/')).map((k) => k.split('/').pop()).sort()).toEqual(['mariadb-secrets', 'woo-api', 'woo-mcp-auth', 'wordpress-admin']);
    expect(helm.calls).toEqual(['install store-tea']);
    expect(helm.values[0]).toMatchObject({ host: 'tea.store', labels: { store: 'tea', partOf: 'store' }, init: { title: 'Chai Corner', tagline: 'Fresh leaves', niche: 'tea-coffee', brand: { enabled: true } }, quota: { enabled: true } });
    expect(gateway.events).toEqual([]); // pods not ready yet

    await r.pass([row()]);
    expect(helm.calls).toEqual(['install store-tea']); // no new revision on every pass
    kube.becomeReady('store-tea');
    await r.pass([row()]);
    const [ev, , body] = gateway.events[0] as [string, string, { wooMcpUrl: string; wooMcpToken: string; adminPassword: string }];
    expect(ev).toBe('ready');
    expect(body.wooMcpUrl).toBe('http://woo-mcp.store-tea.svc.cluster.local/mcp');
    const secret = kube.objects.get('/api/v1/namespaces/store-tea/secrets/woo-mcp-auth')! as { data: { token: string } };
    expect(body.wooMcpToken).toBe(Buffer.from(secret.data.token, 'base64').toString());
    expect(body.wooMcpToken).toMatch(/^[A-Za-z0-9]{48}$/);
    expect(body.adminPassword).toMatch(/^[A-Za-z0-9]{24}$/);
  });
});

describe('TC-BON-09-U2 restart resumes', () => {
  it('a new process keeps the Secrets, skips a deployed release and only reports', async () => {
    const { kube, helm, gateway, mk } = setup();
    await mk().pass([row()]);
    const token = (kube.objects.get('/api/v1/namespaces/store-tea/secrets/woo-mcp-auth') as { data: { token: string } }).data.token;
    kube.becomeReady('store-tea');
    await mk().pass([row()]); // "restarted"
    expect(helm.calls).toEqual(['install store-tea']);
    expect((kube.objects.get('/api/v1/namespaces/store-tea/secrets/woo-mcp-auth') as { data: { token: string } }).data.token).toBe(token);
    expect((gateway.events[0] as unknown[])[0]).toBe('ready');
  });

  it('a release left pending-install by a crash is removed and installed again', async () => {
    const { helm, mk } = setup();
    helm.releases.set('store-tea', 'pending-install');
    await mk().pass([row()]);
    expect(helm.calls).toEqual(['uninstall store-tea', 'install store-tea']);
  });
});

describe('TC-BON-09-U3 guardrails', () => {
  it('past the timeout → failed with a reason naming what is missing; nothing is installed', async () => {
    const { helm, gateway, mk } = setup();
    await mk().pass([row({ createdAt: new Date(Date.now() - 16 * 60_000) })]);
    expect(gateway.events).toEqual([['failed', row().id, 'provisioning timed out after 15 min (namespace not created)']]);
    expect(helm.calls).toEqual([]);
  });

  it('a failed setup Job → failed', async () => {
    const { kube, gateway, mk } = setup();
    const r = mk();
    await r.pass([row()]);
    kube.becomeReady('store-tea', true);
    await r.pass([row()]);
    expect(gateway.events).toEqual([['failed', row().id, 'store setup job failed (see the wp-init Job in the store namespace)']]);
  });

  it('at most maxConcurrent stores at once; ready, failed and deleted rows are left alone', async () => {
    const { helm, mk } = setup();
    const rows = ['aa1', 'bb2', 'cc3', 'dd4'].map((slug, i) => row({ id: `${i}`, slug }));
    await mk().pass([...rows, row({ id: 'x', slug: 'done', status: 'ready' }), row({ id: 'y', slug: 'bad', status: 'failed' })], 3);
    expect(helm.calls).toEqual(['install store-aa1', 'install store-bb2', 'install store-cc3']);
  });
});

describe('TC-BON-09-U4 teardown', () => {
  it('uninstall + delete namespace; deleted is reported only once the namespace is gone', async () => {
    const { kube, helm, gateway, mk } = setup();
    const r = mk();
    await r.pass([row()]);
    const del = row({ desired: 'absent', status: 'deleting' });
    await r.pass([del]);
    expect(helm.calls).toEqual(['install store-tea', 'uninstall store-tea']);
    expect(gateway.events).toEqual([]);
    await r.pass([del]); // still Terminating: no second uninstall
    expect(helm.calls.filter((c) => c.startsWith('uninstall'))).toHaveLength(1);
    kube.objects.delete('/api/v1/namespaces/store-tea');
    await r.pass([del]);
    expect(gateway.events).toEqual([['deleted', row().id]]);
  });
});

describe('TC-BON-09-U5 signing (gateway and provisioner copies agree)', () => {
  const key = Buffer.alloc(32, 7);
  it('a provisioner signature verifies at the gateway; any change to path, body, method, key or time fails', () => {
    const body = JSON.stringify({ reason: 'x' });
    const h = pv.sign(key, 'POST', '/internal/stores/a/failed', body);
    expect(gw.verify(key, h, 'POST', '/internal/stores/a/failed', body)).toBe(true);
    expect(gw.verify(key, h, 'POST', '/internal/stores/b/failed', body)).toBe(false);
    expect(gw.verify(key, h, 'POST', '/internal/stores/a/failed', `${body} `)).toBe(false);
    expect(gw.verify(key, h, 'PUT', '/internal/stores/a/failed', body)).toBe(false);
    expect(gw.verify(Buffer.alloc(32, 8), h, 'POST', '/internal/stores/a/failed', body)).toBe(false);
    expect(gw.verify(key, pv.sign(key, 'POST', '/p', body, Date.now() - 61_000), 'POST', '/p', body)).toBe(false);
    expect(gw.verify(key, undefined, 'POST', '/p', body)).toBe(false);
  });
});
