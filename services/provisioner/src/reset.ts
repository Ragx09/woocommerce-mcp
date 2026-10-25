// BON-12: an admin's wp-admin password reset, carried out inside the store.
//   gateway (sealed password, state pending) → here: open it with the derived key → Secret pw-reset-<t> + one-off Job
//   `wp user update` (same image, volume, user and NetworkPolicy label as the setup Job) → when it succeeded: patch the store's
//   Secret wordpress-admin (so a later Helm upgrade does not revert it) → tell the gateway (it makes the new password viewable
//   once) → remove the Job and the temporary Secret. <t> comes from the request time, so a restart resumes the same Job.
import { createDecipheriv } from 'node:crypto';
import type { Logger } from 'pino';
import type { EncryptedBlob } from './hosted.js';
import type { Kube } from './kube.js';

export interface ResetRow { id: string; slug: string; enc: EncryptedBlob; at: Date }
export interface ResetGateway { passwordReset(id: string, result: { ok: boolean; reason?: string }): Promise<void> }

/** Opens the gateway's blob (AAD `upstream:store-reset:<slug>`, gateway/src/crypto/credentials.ts with slug `store-reset:<slug>`). */
export function openReset(key: Buffer, slug: string, enc: EncryptedBlob): string {
  if (enc.v !== 1) throw new Error(`unsupported version ${String(enc.v)}`);
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'base64'), { authTagLength: 16 });
  d.setAAD(Buffer.from(`upstream:store-reset:${slug}`, 'utf8'));
  const tag = Buffer.from(enc.tag, 'base64');
  if (tag.length !== 16) throw new Error('invalid authentication tag length');
  d.setAuthTag(tag);
  const pw = Buffer.concat([d.update(Buffer.from(enc.ciphertext, 'base64')), d.final()]).toString('utf8');
  if (!/^[A-Za-z0-9]{16,64}$/.test(pw)) throw new Error('unexpected password format');
  return pw;
}

export const resetName = (at: Date) => `pw-reset-${Math.floor(at.getTime() / 1000)}`;
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

export function resetJob(name: string, slug: string, image: string): Record<string, unknown> {
  const labels = { app: 'wp-init', 'platform.io/store': slug, 'app.kubernetes.io/part-of': 'store', 'app.kubernetes.io/name': 'pw-reset' };
  const secretEnv = (n: string, secret: string, key: string) => ({ name: n, valueFrom: { secretKeyRef: { name: secret, key } } });
  return {
    apiVersion: 'batch/v1', kind: 'Job',
    metadata: { name, namespace: `store-${slug}`, labels },
    spec: {
      ttlSecondsAfterFinished: 3600, backoffLimit: 1, activeDeadlineSeconds: 300,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never', automountServiceAccountToken: false, serviceAccountName: 'workload',
          securityContext: { runAsUser: 33, runAsGroup: 33, runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
          containers: [{
            name: 'wp-cli', image, imagePullPolicy: 'IfNotPresent',
            // The password arrives as an environment variable from a Secret; it is never part of the command line.
            command: ['sh', '-c', 'wp --path=/var/www/html user update "$ADMIN_USER" --user_pass="$NEW_PASSWORD" --skip-email'],
            env: [
              { name: 'HOME', value: '/tmp' }, { name: 'WORDPRESS_DB_HOST', value: 'mariadb' }, { name: 'WORDPRESS_DB_NAME', value: 'wordpress' }, { name: 'WORDPRESS_DB_USER', value: 'wordpress' },
              secretEnv('WORDPRESS_DB_PASSWORD', 'mariadb-secrets', 'mariadb-password'), secretEnv('ADMIN_USER', 'wordpress-admin', 'admin-user'), secretEnv('NEW_PASSWORD', name, 'password'),
            ],
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
            volumeMounts: [{ name: 'data', mountPath: '/var/www/html' }, { name: 'tmp', mountPath: '/tmp' }],
            resources: { requests: { cpu: '50m', memory: '96Mi' }, limits: { cpu: '500m', memory: '256Mi' } },
          }],
          volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'wordpress-data' } }, { name: 'tmp', emptyDir: { sizeLimit: '64Mi' } }],
        },
      },
    },
  };
}

export class ResetRunner {
  readonly #inFlight = new Set<string>();
  constructor(private readonly d: { kube: Kube; gateway: ResetGateway; log: Logger; resetKey: Buffer; image: string }) {}

  async pass(rows: ResetRow[]): Promise<void> {
    await Promise.all(rows.filter((r) => !this.#inFlight.has(r.id)).map(async (r) => {
      this.#inFlight.add(r.id);
      try { await this.step(r); } catch (e) { this.d.log.warn({ store: r.slug, err: (e as Error).message }, 'password reset step failed; will retry'); } finally { this.#inFlight.delete(r.id); }
    }));
  }

  async step(r: ResetRow): Promise<void> {
    const { kube, gateway, log } = this.d;
    const ns = `store-${r.slug}`; const name = resetName(r.at);
    const jobPath = `/apis/batch/v1/namespaces/${ns}/jobs/${name}`;
    if (!(await kube.get(`/api/v1/namespaces/${ns}`))) { await gateway.passwordReset(r.id, { ok: false, reason: 'the store\'s namespace does not exist' }); return; }
    let job = await kube.get(jobPath);
    if (!job) {
      let pw: string;
      try { pw = openReset(this.d.resetKey, r.slug, r.enc); } catch { await gateway.passwordReset(r.id, { ok: false, reason: 'the sealed password could not be opened' }); return; }
      await kube.create(`/api/v1/namespaces/${ns}/secrets`, { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', metadata: { name, namespace: ns, labels: { 'platform.io/store': r.slug } }, data: { password: b64(pw) } });
      await kube.create(`/apis/batch/v1/namespaces/${ns}/jobs`, resetJob(name, r.slug, this.d.image));
      log.info({ store: r.slug }, 'password reset job created');
      return; // look again next pass
    }
    const st = job.status as { succeeded?: number; conditions?: { type: string; status: string }[] } | undefined;
    const failed = st?.conditions?.some((c) => c.type === 'Failed' && c.status === 'True');
    if (!failed && (st?.succeeded ?? 0) < 1) return; // still running
    if (!failed) {
      const sec = await kube.get(`/api/v1/namespaces/${ns}/secrets/${name}`);
      const pw = (sec?.data as { password?: string } | undefined)?.password;
      if (!pw) { await gateway.passwordReset(r.id, { ok: false, reason: 'the temporary Secret vanished before the reset was recorded' }); return; }
      await kube.patch(`/api/v1/namespaces/${ns}/secrets/wordpress-admin`, { data: { 'admin-password': pw } }); // idempotent
    }
    // Clean up before reporting: once the gateway has the result this row is no longer pending, so nothing would retry a
    // failed cleanup — and the temporary Secret holds the password. If reporting fails, the next pass simply redoes the
    // (idempotent) reset.
    await kube.remove(jobPath);
    await kube.remove(`/api/v1/namespaces/${ns}/secrets/${name}`);
    await gateway.passwordReset(r.id, failed ? { ok: false, reason: 'the wp-cli reset Job failed (see the pw-reset Job in the store namespace)' } : { ok: true });
    log.info({ store: r.slug, ok: !failed }, 'password reset finished');
  }
}
