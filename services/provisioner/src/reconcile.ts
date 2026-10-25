// D-026 reconcile loop. Desired state is read from Postgres (read-only role); every decision is reported to the
// gateway's signed internal API, which is the only writer. Each step is idempotent, so a provisioner killed at any
// point picks the store up again on its next pass (TC-BON-09-1 / TC-BON-14-3):
//   present + provisioning: namespace (labelled, Pod Security restricted) → RoleBinding store-manager → Secrets
//     (created once, never overwritten) → Helm release (installed once per process; a release left pending by a
//     crash is removed and installed again) → poll readiness → POST ready (woo-mcp URL + token, wp-admin password)
//     timeout (from created_at) or a failed setup Job → POST failed with a short reason
//   absent + deleting: helm uninstall → delete namespace (PVCs, Secrets with it) → wait until gone → POST deleted
import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import type { Helm } from './helm.js';
import type { Kube } from './kube.js';

export interface StoreRow {
  id: string; slug: string; name: string; tagline: string; niche: string; nicheText: string | null;
  status: 'provisioning' | 'ready' | 'failed' | 'deleting' | 'deleted'; desired: 'present' | 'absent'; createdAt: Date;
}

export interface Gateway {
  ready(id: string, body: { wooMcpUrl: string; wooMcpToken: string; adminUser: string; adminPassword: string }): Promise<void>;
  failed(id: string, reason: string): Promise<void>;
  deleted(id: string): Promise<void>;
}

export interface ReconcilerDeps {
  kube: Kube;
  helm: Helm;
  gateway: Gateway;
  log: Logger;
  /** Values every store gets (global, images, gatewayNamespace, quota); per-store fields are added on top. */
  baseValues: Record<string, unknown>;
  /** Provisioning budget from created_at; past it the store is Failed with a reason (A-11 guardrail). */
  timeoutMs: number;
  /** ServiceAccount the store-manager RoleBinding is for (this pod's own account). */
  serviceAccount: { name: string; namespace: string };
  now?: () => number;
}

export const namespaceOf = (slug: string) => `store-${slug}`;
export const releaseOf = (slug: string) => `store-${slug}`;
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const randomText = (n: number) => Array.from(randomBytes(n), (b) => B62[b % 62]).join('');
const hex = (n: number) => randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s: unknown) => Buffer.from(String(s ?? ''), 'base64').toString('utf8');

/** The four Secrets charts/store reads (same names and keys as scripts/make-secrets.sh for the default store). */
export function storeSecrets(slug: string): Record<string, Record<string, string>> {
  return {
    'mariadb-secrets': { 'mariadb-password': randomText(32), 'mariadb-root-password': randomText(32) },
    'wordpress-admin': { 'admin-user': 'storeadmin', 'admin-password': randomText(24), 'admin-email': `admin@${slug}.store.invalid` },
    'woo-api': { 'consumer-key': `ck_${hex(40)}`, 'consumer-secret': `cs_${hex(40)}` },
    'woo-mcp-auth': { token: randomText(48) },
  };
}

export class Reconciler {
  readonly #d: ReconcilerDeps;
  /** Releases installed by this process, so a pass does not create a new Helm revision every few seconds. */
  readonly #installed = new Set<string>();
  readonly #inFlight = new Set<string>();

  constructor(deps: ReconcilerDeps) { this.#d = deps; }

  get inFlight(): ReadonlySet<string> { return this.#inFlight; }

  /** One pass over the rows that need work. Stores are handled concurrently, each at most once at a time. */
  async pass(rows: StoreRow[], maxConcurrent = 3): Promise<void> {
    const todo = rows.filter((r) => !this.#inFlight.has(r.id) && ((r.desired === 'present' && r.status === 'provisioning') || (r.desired === 'absent' && r.status === 'deleting')));
    const slots = Math.max(0, maxConcurrent - this.#inFlight.size);
    await Promise.all(todo.slice(0, slots).map(async (r) => {
      this.#inFlight.add(r.id);
      try {
        if (r.desired === 'absent') await this.teardown(r); else await this.provision(r);
      } catch (e) {
        // Transient (API server, Helm lock, gateway down): logged, retried on the next pass until the timeout.
        this.#d.log.warn({ store: r.slug, err: (e as Error).message }, 'reconcile step failed; will retry');
      } finally {
        this.#inFlight.delete(r.id);
      }
    }));
  }

  async provision(r: StoreRow): Promise<void> {
    const { kube, helm, gateway, log } = this.#d;
    const ns = namespaceOf(r.slug);
    const now = this.#d.now?.() ?? Date.now();
    if (now - r.createdAt.getTime() > this.#d.timeoutMs) {
      const where = await this.describeProgress(ns).catch(() => 'unknown');
      await gateway.failed(r.id, `provisioning timed out after ${Math.round(this.#d.timeoutMs / 60_000)} min (${where})`);
      log.warn({ store: r.slug, where }, 'store provisioning timed out');
      return;
    }
    await kube.create('/api/v1/namespaces', {
      apiVersion: 'v1', kind: 'Namespace',
      metadata: { name: ns, labels: { 'platform.io/store': r.slug, 'app.kubernetes.io/part-of': 'store',
        'pod-security.kubernetes.io/enforce': 'restricted', 'pod-security.kubernetes.io/warn': 'restricted' } },
    });
    await kube.create(`/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings`, {
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding',
      metadata: { name: 'provisioner-store-manager', namespace: ns, labels: { 'platform.io/store': r.slug } },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'store-manager' },
      subjects: [{ kind: 'ServiceAccount', name: this.#d.serviceAccount.name, namespace: this.#d.serviceAccount.namespace }],
    });
    for (const [name, data] of Object.entries(storeSecrets(r.slug))) {
      // 'exists' keeps the first values: a restart never changes a store's passwords or tokens.
      await kube.create(`/api/v1/namespaces/${ns}/secrets`, { apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
        metadata: { name, namespace: ns, labels: { 'platform.io/store': r.slug } },
        data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, b64(v)])) });
    }
    const release = releaseOf(r.slug);
    if (!this.#installed.has(release)) {
      const st = await helm.status(release, ns);
      if (st && st.startsWith('pending')) {
        // A crash during `helm upgrade --install` leaves the release locked; nothing is in use yet, start over.
        log.warn({ store: r.slug, status: st }, 'release left pending by an interrupted install: reinstalling');
        await helm.uninstall(release, ns);
      }
      if (st !== 'deployed') await helm.install(release, ns, this.valuesFor(r));
      this.#installed.add(release);
    }
    const ready = await this.readiness(ns);
    if (ready === 'failed') { await gateway.failed(r.id, 'store setup job failed (see the wp-init Job in the store namespace)'); return; }
    if (ready !== 'ready') return; // poll again next pass
    const mcp = await kube.get(`/api/v1/namespaces/${ns}/secrets/woo-mcp-auth`);
    const admin = await kube.get(`/api/v1/namespaces/${ns}/secrets/wordpress-admin`);
    const md = (mcp?.data ?? {}) as Record<string, string>; const ad = (admin?.data ?? {}) as Record<string, string>;
    await gateway.ready(r.id, { wooMcpUrl: `http://woo-mcp.${ns}.svc.cluster.local/mcp`, wooMcpToken: unb64(md.token),
      adminUser: unb64(ad['admin-user']), adminPassword: unb64(ad['admin-password']) });
    log.info({ store: r.slug }, 'store ready');
  }

  async teardown(r: StoreRow): Promise<void> {
    const ns = namespaceOf(r.slug);
    const nsObj = await this.#d.kube.get(`/api/v1/namespaces/${ns}`);
    if (nsObj) {
      if ((nsObj.status as { phase?: string } | undefined)?.phase !== 'Terminating') {
        await this.#d.helm.uninstall(releaseOf(r.slug), ns);
        await this.#d.kube.remove(`/api/v1/namespaces/${ns}`);
        this.#d.log.info({ store: r.slug }, 'store namespace deleting');
      }
      return; // gone on a later pass
    }
    this.#installed.delete(releaseOf(r.slug));
    await this.#d.gateway.deleted(r.id);
    this.#d.log.info({ store: r.slug }, 'store deleted');
  }

  valuesFor(r: StoreRow): Record<string, unknown> {
    const base = this.#d.baseValues as { init?: Record<string, unknown>; labels?: Record<string, unknown> };
    return {
      ...base,
      host: `${r.slug}.store`,
      labels: { ...(base.labels ?? {}), partOf: 'store', store: r.slug },
      init: { ...(base.init ?? {}), title: r.name, tagline: r.tagline, niche: r.niche, nicheText: r.nicheText ?? '' },
    };
  }

  /** ready | failed (setup Job gave up) | waiting */
  async readiness(ns: string): Promise<'ready' | 'failed' | 'waiting'> {
    const { kube } = this.#d;
    const jobs = (await kube.get(`/apis/batch/v1/namespaces/${ns}/jobs?labelSelector=app%3Dwp-init`))?.items as { status?: { succeeded?: number; conditions?: { type: string; status: string }[] } }[] | undefined;
    if ((jobs ?? []).some((j) => j.status?.conditions?.some((c) => c.type === 'Failed' && c.status === 'True'))) return 'failed';
    const jobDone = (jobs ?? []).some((j) => (j.status?.succeeded ?? 0) > 0);
    const avail = async (kind: string, name: string, field: string) =>
      Number(((await kube.get(`/apis/apps/v1/namespaces/${ns}/${kind}/${name}`))?.status as Record<string, number> | undefined)?.[field] ?? 0) > 0;
    const all = jobDone && await avail('statefulsets', 'mariadb', 'readyReplicas') && await avail('deployments', 'wordpress', 'availableReplicas')
      && await avail('deployments', 'woo-mcp', 'availableReplicas');
    return all ? 'ready' : 'waiting';
  }

  /** Which part is still missing, for the timeout reason (no names or values from the store). */
  async describeProgress(ns: string): Promise<string> {
    const { kube } = this.#d;
    if (!(await kube.get(`/api/v1/namespaces/${ns}`))) return 'namespace not created';
    const parts: string[] = [];
    const ready = async (kind: string, name: string, field: string) =>
      Number(((await kube.get(`/apis/apps/v1/namespaces/${ns}/${kind}/${name}`))?.status as Record<string, number> | undefined)?.[field] ?? 0) > 0;
    if (!(await ready('statefulsets', 'mariadb', 'readyReplicas'))) parts.push('database');
    if (!(await ready('deployments', 'wordpress', 'availableReplicas'))) parts.push('WordPress');
    if (!(await ready('deployments', 'woo-mcp', 'availableReplicas'))) parts.push('MCP server');
    const jobs = (await kube.get(`/apis/batch/v1/namespaces/${ns}/jobs?labelSelector=app%3Dwp-init`))?.items as { status?: { succeeded?: number } }[] | undefined;
    if (!(jobs ?? []).some((j) => (j.status?.succeeded ?? 0) > 0)) parts.push('store setup');
    return parts.length ? `not ready: ${parts.join(', ')}` : 'all parts ready, registration pending';
  }
}
