// The few Kubernetes API calls the provisioner makes, over plain HTTPS with the pod's ServiceAccount token (the
// only pod in the platform that mounts one, D-026). What it may do is decided by RBAC + the admission policy,
// not here: ClusterRole `provisioner` (namespaces, RoleBindings to `store-manager` only) and, inside each
// `store-*` namespace, `store-manager` (the kinds charts/store renders).
import { readFileSync } from 'node:fs';
import { Agent, fetch } from 'undici';

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';

export class KubeError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface Kube {
  get(path: string): Promise<Record<string, unknown> | null>; // null on 404
  create(path: string, body: object): Promise<'created' | 'exists'>;
  remove(path: string): Promise<'deleted' | 'absent'>;
  /** JSON merge patch of an existing object (BON-12: the wp-admin Secret after a password reset). */
  patch(path: string, body: object): Promise<'patched' | 'absent'>;
}

export function inClusterKube(env: NodeJS.ProcessEnv = process.env): Kube {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT ?? '443';
  if (!host) throw new Error('not running in a cluster (KUBERNETES_SERVICE_HOST unset)');
  const base = `https://${host.includes(':') ? `[${host}]` : host}:${port}`;
  const dispatcher = new Agent({ connect: { ca: readFileSync(`${SA}/ca.crt`) } });
  // The token file is rotated by the kubelet (bound tokens): read it per request.
  const headers = () => ({ authorization: `Bearer ${readFileSync(`${SA}/token`, 'utf8').trim()}`, accept: 'application/json' });

  async function call(method: string, path: string, body?: object, contentType = 'application/json') {
    const res = await fetch(`${base}${path}`, { method, dispatcher, signal: AbortSignal.timeout(15_000),
      headers: { ...headers(), ...(body ? { 'content-type': contentType } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    return { status: res.status, json };
  }
  const fail = (method: string, path: string, r: { status: number; json: Record<string, unknown> }) =>
    new KubeError(r.status, `${method} ${path}: ${r.status} ${String(r.json.reason ?? '')} ${String(r.json.message ?? '').slice(0, 200)}`.trim());

  return {
    async get(path) {
      const r = await call('GET', path);
      if (r.status === 404) return null;
      if (r.status >= 300) throw fail('GET', path, r);
      return r.json;
    },
    async create(path, body) {
      const r = await call('POST', path, body);
      if (r.status === 409) return 'exists';
      if (r.status >= 300) throw fail('POST', path, r);
      return 'created';
    },
    async patch(path, body) {
      const r = await call('PATCH', path, body, 'application/merge-patch+json');
      if (r.status === 404) return 'absent';
      if (r.status >= 300) throw fail('PATCH', path, r);
      return 'patched';
    },
    async remove(path) {
      const r = await call('DELETE', path, { propagationPolicy: 'Background' });
      if (r.status === 404) return 'absent';
      if (r.status >= 300) throw fail('DELETE', path, r);
      return 'deleted';
    },
  };
}
