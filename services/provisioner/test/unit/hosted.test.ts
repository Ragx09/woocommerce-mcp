// TC-BON-10-U1..U6: the hosted-server reconcile steps with fake Kubernetes, Helm and gateway. The k3d tests
// (TC-BON-10-1/3, scripts/e2e.sh hosted, k8s-checks.sh hosted) prove the same against the real cluster.
import { randomBytes } from 'node:crypto';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { Helm, ReleaseStatus } from '../../src/helm.js';
import { HostedReconciler, decryptSecretEnv, type HostedGateway, type HostedRow } from '../../src/hosted.js';
import type { Kube } from '../../src/kube.js';
import * as pv from '../../src/signing.js';
import { encryptCredential, type CredentialKey } from '../../../gateway/src/crypto/credentials.js';
import * as gw from '../../../gateway/src/stores/signing.js';

class FakeKube implements Kube {
  objects = new Map<string, Record<string, unknown>>();
  async get(path: string) {
    if (path.includes('/pods?')) {
      const ns = /namespaces\/([^/]+)\//.exec(path)![1]!;
      return { items: this.objects.get(`pods:${ns}`)?.items ?? [] };
    }
    return this.objects.get(path) ?? null;
  }
  async create(path: string, body: Record<string, unknown>) {
    const key = `${path}/${(body.metadata as { name: string }).name}`;
    if (this.objects.has(key)) return 'exists' as const;
    this.objects.set(key, body);
    return 'created' as const;
  }
  async remove(path: string) {
    if (!this.objects.has(path)) return 'absent' as const;
    this.objects.set(path, { ...this.objects.get(path), status: { phase: 'Terminating' } });
    return 'deleted' as const;
  }
  available(ns: string) { this.objects.set(`/apis/apps/v1/namespaces/${ns}/deployments/server`, { status: { availableReplicas: 1 } }); }
  waiting(ns: string, reason: string, exitCode?: number) {
    this.objects.set(`pods:${ns}`, { items: [{ status: { containerStatuses: [{ state: { waiting: { reason } }, lastState: { terminated: { exitCode } } }] } }] });
  }
}
class FakeHelm implements Helm {
  releases = new Map<string, ReleaseStatus>(); calls: string[] = []; values: Record<string, unknown>[] = [];
  async status(release: string) { return this.releases.get(release) ?? null; }
  async install(release: string, _ns: string, values: object) { this.calls.push(`install ${release}`); this.values.push(values as Record<string, unknown>); this.releases.set(release, 'deployed'); }
  async uninstall(release: string) { this.calls.push(`uninstall ${release}`); this.releases.delete(release); }
}
class FakeGateway implements HostedGateway {
  events: unknown[] = [];
  async ready(id: string, b: object) { this.events.push(['ready', id, b]); }
  async failed(id: string, reason: string) { this.events.push(['failed', id, reason]); }
  async deleted(id: string) { this.events.push(['deleted', id]); }
}

const signingKey = randomBytes(32);
const envKey = pv.hostedEnvKey(signingKey);
const row = (over: Partial<HostedRow> = {}): HostedRow => ({ id: '22222222-2222-4222-8222-222222222222', slug: 'echo', name: 'Echo', image: 'ghcr.io/acme/echo:1.0.0',
  port: 3000, path: '/mcp', env: { MODE: 'demo' }, secretEnvEnc: encryptCredential(gw.hostedEnvKey(signingKey) as CredentialKey, 'hosted:echo', JSON.stringify({ API_TOKEN: 'sek-123' })),
  allowEgress: false, status: 'provisioning', desired: 'present', createdAt: new Date(), ...over });
const setup = (now = Date.now()) => {
  const kube = new FakeKube(); const helm = new FakeHelm(); const gateway = new FakeGateway();
  const mk = () => new HostedReconciler({ kube, helm, gateway, log: pino({ level: 'silent' }), envKey, timeoutMs: 5 * 60_000, now: () => now,
    baseValues: { global: { imagePullPolicy: 'IfNotPresent' }, gatewayNamespace: 'platform', resources: { requests: { cpu: '50m' } } },
    serviceAccount: { name: 'provisioner', namespace: 'platform' } });
  return { kube, helm, gateway, mk };
};

describe('TC-BON-10-U1 provision', () => {
  it('labelled namespace, RoleBinding to hosted-manager only, the admin\'s secrets decrypted into server-env, one install, then ready with the Service URL', async () => {
    const { kube, helm, gateway, mk } = setup();
    const r = mk();
    await r.pass([row()]);
    const ns = kube.objects.get('/api/v1/namespaces/hosted-echo')!;
    expect((ns.metadata as { labels: Record<string, string> }).labels).toMatchObject({ 'platform.io/hosted': 'echo', 'pod-security.kubernetes.io/enforce': 'restricted' });
    const rb = kube.objects.get('/apis/rbac.authorization.k8s.io/v1/namespaces/hosted-echo/rolebindings/provisioner-hosted-manager')!;
    expect(rb.roleRef).toEqual({ apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'hosted-manager' });
    const secret = kube.objects.get('/api/v1/namespaces/hosted-echo/secrets/server-env') as { data: Record<string, string> };
    expect(Buffer.from(secret.data.API_TOKEN!, 'base64').toString()).toBe('sek-123');
    expect(helm.calls).toEqual(['install hosted-echo']);
    expect(helm.values[0]).toMatchObject({ slug: 'echo', image: 'ghcr.io/acme/echo:1.0.0', port: 3000, path: '/mcp', env: { MODE: 'demo' }, allowEgress: false, gatewayNamespace: 'platform' });
    expect(JSON.stringify(helm.values[0])).not.toContain('sek-123'); // secrets go to the Secret, never into Helm values/release records
    expect(gateway.events).toEqual([]);
    await r.pass([row()]);
    expect(helm.calls).toHaveLength(1);
    kube.available('hosted-echo');
    await r.pass([row()]);
    expect(gateway.events).toEqual([['ready', row().id, { url: 'http://server.hosted-echo.svc.cluster.local/mcp' }]]);
  });

  it('without secret variables no Secret is created', async () => {
    const { kube, mk } = setup();
    await mk().pass([row({ secretEnvEnc: null })]);
    expect([...kube.objects.keys()].some((k) => k.includes('/secrets/'))).toBe(false);
  });
});

describe('TC-BON-10-U2 secrets', () => {
  it('the provisioner opens exactly what the gateway sealed; another slug, another key or a bit flip does not open', () => {
    const enc = row().secretEnvEnc!;
    expect(decryptSecretEnv(envKey, 'echo', enc)).toEqual({ API_TOKEN: 'sek-123' });
    expect(() => decryptSecretEnv(envKey, 'other', enc)).toThrow();
    expect(() => decryptSecretEnv(pv.hostedEnvKey(randomBytes(32)), 'echo', enc)).toThrow();
    expect(() => decryptSecretEnv(envKey, 'echo', { ...enc, tag: Buffer.alloc(16).toString('base64') })).toThrow();
  });
  it('both copies of the key derivation agree', () => {
    expect(gw.hostedEnvKey(signingKey).equals(pv.hostedEnvKey(signingKey))).toBe(true);
    expect(gw.hostedEnvKey(signingKey).equals(signingKey)).toBe(false);
  });
});

describe('TC-BON-10-U3 restart resumes', () => {
  it('a new process keeps the Secret, skips a deployed release and only reports; a half-installed release is redone', async () => {
    const { kube, helm, gateway, mk } = setup();
    await mk().pass([row()]);
    kube.available('hosted-echo');
    await mk().pass([row()]);
    expect(helm.calls).toEqual(['install hosted-echo']);
    expect((gateway.events[0] as unknown[])[0]).toBe('ready');
    const h2 = setup();
    h2.helm.releases.set('hosted-echo', 'pending-install');
    await h2.mk().pass([row()]);
    expect(h2.helm.calls).toEqual(['uninstall hosted-echo', 'install hosted-echo']);
  });
});

describe('TC-BON-10-U4 failures say why', () => {
  it('an image that cannot be pulled → failed after the grace period, not before', async () => {
    const t = Date.now();
    const early = setup(t);
    early.kube.waiting('hosted-echo', 'ImagePullBackOff');
    await early.mk().pass([row({ createdAt: new Date(t - 30_000) })]);
    expect(early.gateway.events).toEqual([]);
    const late = setup(t);
    late.kube.waiting('hosted-echo', 'ImagePullBackOff');
    await late.mk().pass([row({ createdAt: new Date(t - 120_000) })]);
    expect((late.gateway.events[0] as string[])[2]).toMatch(/image could not be pulled/);
  });
  it('a crash loop names the exit code; a pod Kubernetes refuses names quota or Pod Security; the timeout names what is missing', async () => {
    const t = Date.now();
    const crash = setup(t); crash.kube.waiting('hosted-echo', 'CrashLoopBackOff', 1);
    await crash.mk().pass([row({ createdAt: new Date(t - 120_000) })]);
    expect((crash.gateway.events[0] as string[])[2]).toMatch(/keeps crashing \(exit code 1\)/);
    const quota = setup(t);
    quota.kube.objects.set('/apis/apps/v1/namespaces/hosted-echo/deployments/server', { status: { conditions: [{ type: 'ReplicaFailure', status: 'True', reason: 'FailedCreate' }] } });
    await quota.mk().pass([row({ createdAt: new Date(t - 120_000) })]);
    expect((quota.gateway.events[0] as string[])[2]).toMatch(/quota or Pod Security/);
    const slow = setup(t);
    await slow.mk().pass([row({ createdAt: new Date(t - 6 * 60_000) })]);
    expect((slow.gateway.events[0] as string[])[2]).toMatch(/not ready after 5 min/);
    expect(slow.helm.calls).toEqual([]);
  });
});

describe('TC-BON-10-U5 teardown', () => {
  it('uninstall → delete the namespace → deleted only once it is gone; nothing else is touched', async () => {
    const { kube, helm, gateway, mk } = setup();
    const r = mk();
    await r.pass([row()]);
    const del = row({ desired: 'absent', status: 'deleting' });
    await r.pass([del]);
    expect(helm.calls).toEqual(['install hosted-echo', 'uninstall hosted-echo']);
    expect(gateway.events).toEqual([]);
    await r.pass([del]); // namespace Terminating: wait
    expect(helm.calls).toHaveLength(2);
    kube.objects.delete('/api/v1/namespaces/hosted-echo');
    await r.pass([del]);
    expect(gateway.events).toEqual([['deleted', del.id]]);
  });
});
