// BON-10 (D-029): the reconcile loop for hosted MCP servers, same shape as stores (reconcile.ts):
//   present + provisioning: namespace hosted-<slug> (labelled, Pod Security restricted) → RoleBinding hosted-manager →
//     Secret server-env (the admin's secret variables, decrypted here with the key derived from the signing key;
//     created once, never overwritten) → Helm release of charts/hosted → poll the Deployment → POST ready (Service URL)
//     a pod that cannot pull its image or keeps crashing, or no readiness within the timeout → POST failed with a reason
//   absent + deleting: helm uninstall → delete namespace (Secret, Service, policies with it) → wait until gone → POST deleted
// Every step is idempotent, so a provisioner killed at any point resumes on the next pass.
import { createDecipheriv } from 'node:crypto';
import type { Logger } from 'pino';
import type { Helm } from './helm.js';
import type { Kube } from './kube.js';

export interface EncryptedBlob { v: number; iv: string; ciphertext: string; tag: string }
export interface HostedRow {
  id: string; slug: string; name: string; image: string; port: number; path: string; env: Record<string, string>;
  secretEnvEnc: EncryptedBlob | null; allowEgress: boolean;
  status: 'provisioning' | 'ready' | 'failed' | 'deleting' | 'deleted'; desired: 'present' | 'absent'; createdAt: Date;
}
export interface HostedGateway {
  ready(id: string, body: { url: string }): Promise<void>;
  failed(id: string, reason: string): Promise<void>;
  deleted(id: string): Promise<void>;
}
export interface HostedDeps {
  kube: Kube; helm: Helm; gateway: HostedGateway; log: Logger;
  /** Values every hosted server gets (global, gatewayNamespace, resources, quota). */
  baseValues: Record<string, unknown>;
  /** The key the gateway encrypted the secret environment with (HKDF of the signing key). */
  envKey: Buffer;
  timeoutMs: number;
  serviceAccount: { name: string; namespace: string };
  now?: () => number;
}

export const hostedNamespace = (slug: string) => `hosted-${slug}`;
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/** Opens the gateway's blob (AES-256-GCM, AAD `upstream:hosted:<slug>`, see gateway/src/crypto/credentials.ts). */
export function decryptSecretEnv(key: Buffer, slug: string, enc: EncryptedBlob): Record<string, string> {
  if (enc.v !== 1) throw new Error(`unsupported secret version ${String(enc.v)}`);
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'base64'));
  d.setAAD(Buffer.from(`upstream:hosted:${slug}`, 'utf8'));
  d.setAuthTag(Buffer.from(enc.tag, 'base64'));
  const json = Buffer.concat([d.update(Buffer.from(enc.ciphertext, 'base64')), d.final()]).toString('utf8');
  const obj = JSON.parse(json) as unknown;
  if (typeof obj !== 'object' || obj === null || Object.values(obj).some((v) => typeof v !== 'string')) throw new Error('secret environment is not a string map');
  return obj as Record<string, string>;
}

export class HostedReconciler {
  readonly #d: HostedDeps;
  readonly #installed = new Set<string>();
  readonly #inFlight = new Set<string>();
  constructor(deps: HostedDeps) { this.#d = deps; }
  get inFlight(): ReadonlySet<string> { return this.#inFlight; }

  async pass(rows: HostedRow[], maxConcurrent = 3): Promise<void> {
    const todo = rows.filter((r) => !this.#inFlight.has(r.id) && ((r.desired === 'present' && r.status === 'provisioning') || (r.desired === 'absent' && r.status === 'deleting')));
    const slots = Math.max(0, maxConcurrent - this.#inFlight.size);
    await Promise.all(todo.slice(0, slots).map(async (r) => {
      this.#inFlight.add(r.id);
      try {
        if (r.desired === 'absent') await this.teardown(r); else await this.provision(r);
      } catch (e) {
        this.#d.log.warn({ hosted: r.slug, err: (e as Error).message }, 'hosted reconcile step failed; will retry');
      } finally {
        this.#inFlight.delete(r.id);
      }
    }));
  }

  async provision(r: HostedRow): Promise<void> {
    const { kube, helm, gateway, log } = this.#d;
    const ns = hostedNamespace(r.slug);
    const now = this.#d.now?.() ?? Date.now();
    const problem = await this.problem(ns).catch(() => null);
    if (problem && now - r.createdAt.getTime() > 90_000) {
      // An image that cannot be pulled or keeps crashing will not fix itself: say so after a short grace period.
      await gateway.failed(r.id, problem);
      log.warn({ hosted: r.slug, problem }, 'hosted server failed');
      return;
    }
    if (now - r.createdAt.getTime() > this.#d.timeoutMs) {
      await gateway.failed(r.id, `not ready after ${Math.round(this.#d.timeoutMs / 60_000)} min${problem ? `: ${problem}` : ' (the server did not start listening)'}`);
      log.warn({ hosted: r.slug }, 'hosted server provisioning timed out');
      return;
    }
    await kube.create('/api/v1/namespaces', {
      apiVersion: 'v1', kind: 'Namespace',
      metadata: { name: ns, labels: { 'platform.io/hosted': r.slug, 'app.kubernetes.io/part-of': 'hosted',
        'pod-security.kubernetes.io/enforce': 'restricted', 'pod-security.kubernetes.io/warn': 'restricted' } },
    });
    await kube.create(`/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings`, {
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding',
      metadata: { name: 'provisioner-hosted-manager', namespace: ns, labels: { 'platform.io/hosted': r.slug } },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'hosted-manager' },
      subjects: [{ kind: 'ServiceAccount', name: this.#d.serviceAccount.name, namespace: this.#d.serviceAccount.namespace }],
    });
    if (r.secretEnvEnc) {
      const secrets = decryptSecretEnv(this.#d.envKey, r.slug, r.secretEnvEnc);
      await kube.create(`/api/v1/namespaces/${ns}/secrets`, { apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
        metadata: { name: 'server-env', namespace: ns, labels: { 'platform.io/hosted': r.slug } },
        data: Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, b64(v)])) });
    }
    const release = `hosted-${r.slug}`;
    if (!this.#installed.has(release)) {
      const st = await helm.status(release, ns);
      if (st && st.startsWith('pending')) {
        log.warn({ hosted: r.slug, status: st }, 'release left pending by an interrupted install: reinstalling');
        await helm.uninstall(release, ns);
      }
      if (st !== 'deployed') await helm.install(release, ns, this.valuesFor(r));
      this.#installed.add(release);
    }
    const dep = await kube.get(`/apis/apps/v1/namespaces/${ns}/deployments/server`);
    if (Number((dep?.status as Record<string, number> | undefined)?.availableReplicas ?? 0) < 1) return; // poll again next pass
    await gateway.ready(r.id, { url: `http://server.${ns}.svc.cluster.local${r.path}` });
    log.info({ hosted: r.slug }, 'hosted server ready');
  }

  async teardown(r: HostedRow): Promise<void> {
    const ns = hostedNamespace(r.slug);
    const nsObj = await this.#d.kube.get(`/api/v1/namespaces/${ns}`);
    if (nsObj) {
      if ((nsObj.status as { phase?: string } | undefined)?.phase !== 'Terminating') {
        await this.#d.helm.uninstall(`hosted-${r.slug}`, ns);
        await this.#d.kube.remove(`/api/v1/namespaces/${ns}`);
        this.#d.log.info({ hosted: r.slug }, 'hosted namespace deleting');
      }
      return;
    }
    this.#installed.delete(`hosted-${r.slug}`);
    await this.#d.gateway.deleted(r.id);
    this.#d.log.info({ hosted: r.slug }, 'hosted server deleted');
  }

  valuesFor(r: HostedRow): Record<string, unknown> {
    return { ...this.#d.baseValues, slug: r.slug, name: r.name, image: r.image, port: r.port, path: r.path, env: r.env, allowEgress: r.allowEgress };
  }

  /** A short reason when the pod cannot work (image pull, crash loop, refused by quota/Pod Security), else null. No names or values. */
  async problem(ns: string): Promise<string | null> {
    const pods = (await this.#d.kube.get(`/api/v1/namespaces/${ns}/pods?labelSelector=app%3Dhosted-server`))?.items as
      { status?: { containerStatuses?: { state?: { waiting?: { reason?: string } }; lastState?: { terminated?: { reason?: string; exitCode?: number } }; restartCount?: number }[] } }[] | undefined;
    for (const p of pods ?? []) {
      for (const c of p.status?.containerStatuses ?? []) {
        const w = c.state?.waiting?.reason;
        if (w === 'ErrImagePull' || w === 'ImagePullBackOff' || w === 'InvalidImageName') return 'the image could not be pulled (check the name, tag and that the registry is reachable and public or has a pull secret)';
        if (w === 'CrashLoopBackOff') return `the server keeps crashing (exit code ${c.lastState?.terminated?.exitCode ?? '?'}); it must run as a non-root user with a read-only filesystem`;
        if (w === 'CreateContainerConfigError') return 'the container could not be configured (a non-root user the image cannot run as?)';
      }
    }
    const dep = await this.#d.kube.get(`/apis/apps/v1/namespaces/${ns}/deployments/server`);
    const failure = ((dep?.status as { conditions?: { type: string; status: string; reason?: string }[] } | undefined)?.conditions ?? [])
      .find((c) => c.type === 'ReplicaFailure' && c.status === 'True');
    return failure ? `Kubernetes refused to start the pod (${(failure.reason ?? 'ReplicaFailure').slice(0, 60)}): quota or Pod Security` : null;
  }
}
