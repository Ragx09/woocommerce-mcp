// TC-BON-12-U1..U4 / TC-BON-14-U5: runtime numbers, the vanished-namespace report, and the wp-admin password reset steps,
// with fake Kubernetes and gateway. The cluster proof is scripts/e2e.sh stores/hosted and the browser scripts.
import { randomBytes } from 'node:crypto';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { Monitor, collectRuntime, cpuCores, memoryMiB, type MonitorGateway, type RuntimeSnapshot } from '../../src/monitor.js';
import { decryptSecretEnv } from '../../src/hosted.js';
import { ResetRunner, openReset, resetJob, resetName, type ResetGateway } from '../../src/reset.js';
import type { Kube } from '../../src/kube.js';
import * as pv from '../../src/signing.js';
import * as gw from '../../../gateway/src/stores/signing.js';
import { encryptCredential, type CredentialKey } from '../../../gateway/src/crypto/credentials.js';

class FakeKube implements Kube {
  objects = new Map<string, Record<string, any>>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  removed: string[] = [];
  async get(path: string) { return this.objects.get(path) ?? null; }
  async create(path: string, body: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
    const key = `${path}/${body.metadata.name}`;
    if (this.objects.has(key)) return 'exists' as const;
    this.objects.set(key, body); return 'created' as const;
  }
  async patch(path: string, body: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
    const cur = this.objects.get(path); if (!cur) return 'absent' as const;
    this.objects.set(path, { ...cur, data: { ...(cur.data ?? {}), ...(body.data ?? {}) } }); return 'patched' as const;
  }
  async remove(path: string) { this.removed.push(path); return this.objects.delete(path) ? 'deleted' as const : 'absent' as const; }
}
const log = pino({ level: 'silent' });
const ready = { status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };

describe('TC-BON-12-U1 quantities and runtime', () => {
  it('CPU and memory quantities → cores and MiB', () => {
    expect([cpuCores('4'), cpuCores('500m'), cpuCores('2250m'), cpuCores(undefined)]).toEqual([4, 0.5, 2.25, 0]);
    expect([memoryMiB('3Gi'), memoryMiB('512Mi'), memoryMiB('1500Mi'), memoryMiB('134217728'), memoryMiB('1024Ki'), memoryMiB('junk')]).toEqual([3072, 512, 1500, 128, 1, 0]);
  });
  it('counts live pods (not completed Jobs) and the quota numbers', async () => {
    const k = new FakeKube();
    k.objects.set('/api/v1/namespaces/store-tea/pods', { items: [ready, ready, { status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }] } }, { status: { phase: 'Succeeded' } }] });
    k.objects.set('/api/v1/namespaces/store-tea/resourcequotas/store', { status: { hard: { 'limits.cpu': '4', 'limits.memory': '3Gi' }, used: { 'limits.cpu': '2100m', 'limits.memory': '1536Mi' } } });
    expect(await collectRuntime(k, 'store-tea', 'store')).toEqual({ pods: { ready: 2, total: 3 }, quota: { cpuLimits: { used: 2.1, hard: 4 }, memoryLimitsMiB: { used: 1536, hard: 3072 } } });
    k.objects.delete('/api/v1/namespaces/store-tea/resourcequotas/store');
    expect((await collectRuntime(k, 'store-tea', 'store'))?.quota).toBeUndefined();
    expect(await collectRuntime(k, 'store-none', 'store')).toBeNull();
  });
});

describe('TC-BON-14-U2 vanished namespace', () => {
  const setup = () => {
    const k = new FakeKube(); const events: unknown[] = [];
    const g: MonitorGateway = { runtime: async (id, s: RuntimeSnapshot) => { events.push(['runtime', id, s.pods]); }, missing: async (id) => { events.push(['missing', id]); } };
    return { k, events, m: new Monitor({ kube: k, gateway: g, log, namespacePrefix: 'store-', quotaName: 'store' }) };
  };
  it('reports runtime while the namespace exists; reports "missing" only after three consecutive misses; a blip resets the count', async () => {
    const { k, events, m } = setup();
    const row = [{ id: 's1', slug: 'tea' }];
    k.objects.set('/api/v1/namespaces/store-tea', { status: { phase: 'Active' } });
    k.objects.set('/api/v1/namespaces/store-tea/pods', { items: [ready] });
    await m.watch(row);
    expect(events).toEqual([['runtime', 's1', { ready: 1, total: 1 }]]);
    events.length = 0;
    const ns = k.objects.get('/api/v1/namespaces/store-tea')!;
    k.objects.delete('/api/v1/namespaces/store-tea');
    await m.watch(row); await m.watch(row);
    expect(events).toEqual([]); // two misses: not yet
    k.objects.set('/api/v1/namespaces/store-tea', ns); // back (API blip)
    await m.watch(row);
    k.objects.delete('/api/v1/namespaces/store-tea');
    await m.watch(row); await m.watch(row);
    expect(events.filter((e) => (e as string[])[0] === 'missing')).toEqual([]); // the count started over
    await m.watch(row);
    expect(events.filter((e) => (e as string[])[0] === 'missing')).toEqual([['missing', 's1']]);
    events.length = 0;
    await m.watch([]); // no longer ready → forgotten
    await m.watch(row);
    expect(events).toEqual([]); // starts from zero again
  });
  it('one failing row does not stop the others', async () => {
    const { k, events, m } = setup();
    const get = k.get.bind(k);
    k.get = async (p: string) => { if (p.includes('store-bad')) throw new Error('boom'); return get(p); };
    k.objects.set('/api/v1/namespaces/store-ok', {}); k.objects.set('/api/v1/namespaces/store-ok/pods', { items: [ready] });
    await m.watch([{ id: 'b', slug: 'bad' }, { id: 'o', slug: 'ok' }]);
    expect(events).toEqual([['runtime', 'o', { ready: 1, total: 1 }]]);
  });
});

describe('TC-BON-12-U3 password reset', () => {
  const signingKey = randomBytes(32);
  const resetKey = pv.storeResetKey(signingKey);
  const at = new Date('2026-10-25T12:00:00Z');
  const sealed = (pw: string) => encryptCredential(gw.storeResetKey(signingKey) as CredentialKey, 'store-reset:tea', pw);
  const setup = () => {
    const k = new FakeKube(); const results: unknown[] = [];
    k.objects.set('/api/v1/namespaces/store-tea', {});
    k.objects.set('/api/v1/namespaces/store-tea/secrets/wordpress-admin', { data: { 'admin-user': 'c3RvcmVhZG1pbg==', 'admin-password': 'b2xk' } });
    const g: ResetGateway = { passwordReset: async (id, r) => { results.push([id, r]); } };
    return { k, results, run: new ResetRunner({ kube: k, gateway: g, log, resetKey, image: 'wordpress:cli-test' }) };
  };
  const row = (pw = 'NewPassw0rdNewPassw0rd12') => ({ id: 's1', slug: 'tea', enc: sealed(pw), at });
  const jobPath = `/apis/batch/v1/namespaces/store-tea/jobs/${resetName(at)}`;

  it('the derived keys agree and the gateway\'s blob opens only with the right key, slug and bytes', () => {
    expect(gw.storeResetKey(signingKey).equals(pv.storeResetKey(signingKey))).toBe(true);
    expect(gw.storeResetKey(signingKey).equals(pv.hostedEnvKey(signingKey))).toBe(false); // separate labels, separate keys
    const r = row();
    expect(openReset(resetKey, 'tea', r.enc)).toBe('NewPassw0rdNewPassw0rd12');
    expect(() => openReset(resetKey, 'other', r.enc)).toThrow();
    expect(() => openReset(pv.hostedEnvKey(signingKey), 'tea', r.enc)).toThrow();
  });

  it('F-CRY-1: truncated authentication tags are refused by both openers (prefix of the real tag)', () => {
    const r = row();
    const tag = Buffer.from(r.enc.tag, 'base64');
    for (const n of [0, 4, 8, 12]) {
      expect(() => openReset(resetKey, 'tea', { ...r.enc, tag: tag.subarray(0, n).toString('base64') }), `reset ${n}`).toThrow(/tag/i);
      expect(() => decryptSecretEnv(pv.hostedEnvKey(signingKey), 'tea', { ...r.enc, tag: tag.subarray(0, n).toString('base64') }), `hosted ${n}`).toThrow(/tag/i);
    }
  });

  it('creates the temporary Secret and the Job once, waits while it runs, then patches wordpress-admin, cleans up and reports ok', async () => {
    const { k, results, run } = setup();
    await run.pass([row()]);
    const sec = k.objects.get(`/api/v1/namespaces/store-tea/secrets/${resetName(at)}`)!;
    expect(Buffer.from(sec.data.password, 'base64').toString()).toBe('NewPassw0rdNewPassw0rd12');
    const job = k.objects.get(jobPath)!;
    expect(job.spec.template.metadata.labels.app).toBe('wp-init'); // the store's wp-init NetworkPolicy applies (MariaDB, DNS)
    const c = job.spec.template.spec.containers[0];
    expect(JSON.stringify(c.command)).not.toContain('NewPassw0rd'); // never on the command line
    expect(c.env.find((e: { name: string }) => e.name === 'NEW_PASSWORD').valueFrom.secretKeyRef).toEqual({ name: resetName(at), key: 'password' });
    expect([job.spec.template.spec.securityContext.runAsNonRoot, c.securityContext.readOnlyRootFilesystem, job.spec.template.spec.automountServiceAccountToken]).toEqual([true, true, false]);
    await run.pass([row()]); // running: nothing new
    expect(results).toEqual([]);
    k.objects.set(jobPath, { ...job, status: { succeeded: 1 } });
    await run.pass([row()]);
    const admin = k.objects.get('/api/v1/namespaces/store-tea/secrets/wordpress-admin')!;
    expect(Buffer.from(admin.data['admin-password'], 'base64').toString()).toBe('NewPassw0rdNewPassw0rd12');
    expect(admin.data['admin-user']).toBe('c3RvcmVhZG1pbg==');
    expect(results).toEqual([['s1', { ok: true }]]);
    expect(k.objects.has(jobPath)).toBe(false);
    expect(k.objects.has(`/api/v1/namespaces/store-tea/secrets/${resetName(at)}`)).toBe(false); // no password left behind
  });

  it('a failed Job reports why, leaves the old password, and cleans up; a restart resumes the same Job', async () => {
    const { k, results, run } = setup();
    await run.pass([row()]);
    const created = k.objects.size;
    const again = setup(); // a "restarted" runner sharing the cluster state
    again.k.objects = k.objects;
    await again.run.pass([row()]);
    expect(k.objects.size).toBe(created); // same Job name: no second Job, no second Secret
    k.objects.set(jobPath, { ...k.objects.get(jobPath), status: { conditions: [{ type: 'Failed', status: 'True' }] } });
    await run.pass([row()]);
    expect(results).toHaveLength(1);
    expect((results[0] as [string, { ok: boolean; reason: string }])[1]).toMatchObject({ ok: false, reason: expect.stringMatching(/reset Job failed/) });
    expect(Buffer.from(k.objects.get('/api/v1/namespaces/store-tea/secrets/wordpress-admin')!.data['admin-password'], 'base64').toString()).toBe('old');
    expect(k.objects.has(jobPath)).toBe(false);
  });

  it('a missing namespace or an unopenable seal is reported as a failure, never retried forever', async () => {
    const a = setup(); a.k.objects.delete('/api/v1/namespaces/store-tea');
    await a.run.pass([row()]);
    expect((a.results[0] as [string, { reason: string }])[1].reason).toMatch(/namespace does not exist/);
    const b = setup();
    await b.run.pass([{ ...row(), enc: { ...row().enc, tag: Buffer.alloc(16).toString('base64') } }]);
    expect((b.results[0] as [string, { reason: string }])[1].reason).toMatch(/could not be opened/);
    expect([...b.k.objects.keys()].some((x) => x.includes('/jobs/'))).toBe(false);
  });

  it('the Job manifest matches the store chart\'s setup Job where it matters', () => {
    const j = resetJob('pw-reset-1', 'tea', 'wordpress:cli-x') as { spec: { template: { spec: { securityContext: Record<string, unknown>; volumes: { persistentVolumeClaim?: { claimName: string } }[] } } } };
    expect(j.spec.template.spec.securityContext).toMatchObject({ runAsUser: 33, runAsNonRoot: true });
    expect(j.spec.template.spec.volumes[0]!.persistentVolumeClaim!.claimName).toBe('wordpress-data');
  });
});
