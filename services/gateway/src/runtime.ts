// BON-12: the provisioner reports how a store or hosted server looks right now (pods ready, quota used). The gateway keeps
// only validated numbers — nothing the provisioner (or the workload behind it) could smuggle text through.
import type { RuntimeSnapshot } from './db/schema.js';

const num = (v: unknown, max: number): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v * 1000) / 1000 : null);

export function parseRuntime(body: unknown): RuntimeSnapshot | null {
  const b = body as { pods?: { ready?: unknown; total?: unknown }; quota?: { cpuLimits?: { used?: unknown; hard?: unknown }; memoryLimitsMiB?: { used?: unknown; hard?: unknown } } } | null;
  const ready = num(b?.pods?.ready, 1000);
  const total = num(b?.pods?.total, 1000);
  if (ready === null || total === null || ready > total) return null;
  const out: RuntimeSnapshot = { pods: { ready, total } };
  if (b?.quota !== undefined) {
    const cu = num(b.quota?.cpuLimits?.used, 100_000); const ch = num(b.quota?.cpuLimits?.hard, 100_000);
    const mu = num(b.quota?.memoryLimitsMiB?.used, 10_000_000); const mh = num(b.quota?.memoryLimitsMiB?.hard, 10_000_000);
    if (cu === null || ch === null || mu === null || mh === null) return null;
    out.quota = { cpuLimits: { used: cu, hard: ch }, memoryLimitsMiB: { used: mu, hard: mh } };
  }
  return out;
}
