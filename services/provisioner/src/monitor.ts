// BON-12 / BON-14: what the provisioner keeps an eye on once a store or hosted server is Ready.
//   runtime  — pods ready/total and the namespace quota (numbers only) reported to the gateway for the admin view
//   missing  — the namespace is gone although the row says Ready (someone ran `kubectl delete ns`): after three
//              consecutive 404s (a single API hiccup is not enough) the gateway is told, which marks the row Failed with
//              that reason and unregisters the MCP server. Deleting the row from the dashboard then cleans up the rest.
import type { Logger } from 'pino';
import type { Kube } from './kube.js';

export interface RuntimeSnapshot {
  pods: { ready: number; total: number };
  quota?: { cpuLimits: { used: number; hard: number }; memoryLimitsMiB: { used: number; hard: number } };
}
export interface MonitorGateway {
  runtime(id: string, snap: RuntimeSnapshot): Promise<void>;
  missing(id: string): Promise<void>;
}
export interface ReadyRow { id: string; slug: string }

/** CPU quantity ("4", "500m") → cores. */
export function cpuCores(q: unknown): number {
  const s = String(q ?? '').trim();
  if (!s) return 0;
  return s.endsWith('m') ? Number(s.slice(0, -1)) / 1000 : Number(s);
}
const MEM_UNITS: Record<string, number> = { Ki: 1 / 1024, Mi: 1, Gi: 1024, Ti: 1024 * 1024, K: 1000 / 1048576, M: 1e6 / 1048576, G: 1e9 / 1048576 };
/** Memory quantity ("3Gi", "512Mi", "134217728") → MiB. */
export function memoryMiB(q: unknown): number {
  const m = /^(\d+(?:\.\d+)?)([A-Za-z]{0,2})$/.exec(String(q ?? '').trim());
  if (!m) return 0;
  const n = Number(m[1]);
  return m[2] ? n * (MEM_UNITS[m[2]] ?? 0) : n / 1048576;
}

/** Pods that still count (not completed Jobs), how many are Ready, and the quota's used/hard for CPU and memory limits. */
export async function collectRuntime(kube: Kube, ns: string, quotaName: string): Promise<RuntimeSnapshot | null> {
  const pods = (await kube.get(`/api/v1/namespaces/${ns}/pods`))?.items as { status?: { phase?: string; conditions?: { type: string; status: string }[] } }[] | undefined;
  if (!pods) return null;
  const live = pods.filter((p) => p.status?.phase !== 'Succeeded' && p.status?.phase !== 'Failed');
  const ready = live.filter((p) => p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True')).length;
  const snap: RuntimeSnapshot = { pods: { ready, total: live.length } };
  const q = (await kube.get(`/api/v1/namespaces/${ns}/resourcequotas/${quotaName}`))?.status as { hard?: Record<string, string>; used?: Record<string, string> } | undefined;
  if (q?.hard?.['limits.cpu'] && q.hard['limits.memory']) {
    snap.quota = {
      cpuLimits: { used: cpuCores(q.used?.['limits.cpu']), hard: cpuCores(q.hard['limits.cpu']) },
      memoryLimitsMiB: { used: Math.round(memoryMiB(q.used?.['limits.memory'])), hard: Math.round(memoryMiB(q.hard['limits.memory'])) },
    };
  }
  return snap;
}

export class Monitor {
  readonly #misses = new Map<string, number>();
  constructor(private readonly d: { kube: Kube; gateway: MonitorGateway; log: Logger; namespacePrefix: string; quotaName: string; missesBeforeReport?: number }) {}

  /** One look at every Ready row. Errors for one row never stop the others. */
  async watch(rows: ReadyRow[]): Promise<void> {
    const limit = this.d.missesBeforeReport ?? 3;
    const alive = new Set(rows.map((r) => r.id));
    for (const id of this.#misses.keys()) if (!alive.has(id)) this.#misses.delete(id);
    for (const r of rows) {
      const ns = `${this.d.namespacePrefix}${r.slug}`;
      try {
        if (!(await this.d.kube.get(`/api/v1/namespaces/${ns}`))) {
          const n = (this.#misses.get(r.id) ?? 0) + 1;
          this.#misses.set(r.id, n);
          if (n >= limit) {
            await this.d.gateway.missing(r.id);
            this.#misses.delete(r.id);
            this.d.log.warn({ ns }, 'namespace of a ready server is gone; reported');
          }
          continue;
        }
        this.#misses.delete(r.id);
        const snap = await collectRuntime(this.d.kube, ns, this.d.quotaName);
        if (snap) await this.d.gateway.runtime(r.id, snap);
      } catch (e) {
        this.d.log.warn({ ns, err: (e as Error).message }, 'monitor step failed; will retry');
      }
    }
  }
}
