// Helm, run as a child process with a pinned binary from the image and the store chart baked in at
// /charts/store. Arguments are an array (no shell), values go in a JSON file (no --set escaping of user text).
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type ReleaseStatus = 'deployed' | 'failed' | 'pending-install' | 'pending-upgrade' | 'pending-rollback' | 'uninstalling' | 'superseded' | 'unknown';

export interface Helm {
  status(release: string, namespace: string): Promise<ReleaseStatus | null>; // null: no such release
  install(release: string, namespace: string, values: object): Promise<void>;
  uninstall(release: string, namespace: string): Promise<void>;
}

export function helmCli(opts: { bin?: string; chart?: string; timeoutMs?: number } = {}): Helm {
  const bin = opts.bin ?? 'helm';
  const chart = opts.chart ?? '/charts/store';
  const timeout = opts.timeoutMs ?? 120_000;
  const helm = (args: string[]) => run(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, HELM_CACHE_HOME: '/tmp/helm/cache', HELM_CONFIG_HOME: '/tmp/helm/config', HELM_DATA_HOME: '/tmp/helm/data' } });
  /** Helm's stderr without anything that could be a value (it echoes manifests on some errors): first line, capped. */
  const reason = (e: unknown) => String((e as { stderr?: string }).stderr ?? (e as Error).message).split('\n').find((l) => l.trim())?.slice(0, 200) ?? 'helm failed';

  return {
    async status(release, namespace) {
      try {
        const { stdout } = await helm(['status', release, '-n', namespace, '-o', 'json']);
        return ((JSON.parse(stdout) as { info?: { status?: ReleaseStatus } }).info?.status) ?? 'unknown';
      } catch (e) {
        if (/not found/i.test(String((e as { stderr?: string }).stderr ?? ''))) return null;
        throw new Error(`helm status: ${reason(e)}`);
      }
    },
    async install(release, namespace, values) {
      const dir = await mkdtemp(join(tmpdir(), 'store-'));
      try {
        const file = join(dir, 'values.json');
        await writeFile(file, JSON.stringify(values), { mode: 0o600 });
        // No --wait: readiness is polled by the reconciler, so a restart mid-wait loses nothing.
        await helm(['upgrade', '--install', release, chart, '-n', namespace, '-f', file, '--history-max', '3']);
      } catch (e) {
        throw new Error(`helm install: ${reason(e)}`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async uninstall(release, namespace) {
      try {
        await helm(['uninstall', release, '-n', namespace, '--wait', '--timeout', '5m']);
      } catch (e) {
        if (/not found/i.test(String((e as { stderr?: string }).stderr ?? ''))) return;
        throw new Error(`helm uninstall: ${reason(e)}`);
      }
    },
  };
}
