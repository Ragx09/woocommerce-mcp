// BON-10: hosted MCP servers. An admin names a container image (from an allowed registry) and the platform runs it in
// its own namespace — non-root, read-only, no network beyond the gateway — then registers it as a server. Secret
// variables are write-only: they are never shown again, only their names.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, type HostedList, type HostedServerInfo } from '../api.js';
import { when } from '../components.js';
import { StoreStatusBadge } from './Stores.js';

/** `A=1` per line → { A: '1' }; a line without `=` is an error the form shows. */
export function parseEnv(text: string): { env: Record<string, string>; error?: string } {
  const env: Record<string, string> = {};
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq < 1) return { env, error: `line ${i + 1}: write NAME=value` };
    env[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return { env };
}
export const slugFrom = (name: string) => name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16).replace(/-+$/, '');

const refetch = (d?: HostedList) => (d?.servers.some((s) => s.status === 'provisioning' || s.status === 'deleting') ? 4_000 : 15_000);

export function Hosted() {
  const list = useQuery({ queryKey: ['hosted'], queryFn: () => api<HostedList>('/api/hosted'),
    refetchInterval: (q) => refetch(q.state.data), refetchIntervalInBackground: false });
  const d = list.data;
  return (
    <section className="stack" aria-labelledby="hosted-h">
      <div>
        <h2 id="hosted-h">Hosted servers</h2>
        <p className="muted small">
          Run an MCP server from a container image. It gets its own namespace, no network except the gateway, and the tools appear here once it is ready.
          Members get no access until you allow it on the server.
        </p>
      </div>
      {list.isError && <p className="error" role="alert">{list.error.message}</p>}
      {d && !d.enabled && <div className="card muted small">Hosting by image is not set up on this installation (needs the provisioner and at least one allowed registry).</div>}
      {d?.enabled && <AddHosted registries={d.registries} atLimit={d.servers.length >= d.max} />}
      {d?.servers.map((s) => <HostedCard key={s.id} s={s} />)}
    </section>
  );
}

function AddHosted({ registries, atLimit }: { registries: string[]; atLimit: boolean }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [image, setImage] = useState('');
  const [port, setPort] = useState('3000');
  const [path, setPath] = useState('/mcp');
  const [envText, setEnvText] = useState('');
  const [secretText, setSecretText] = useState('');
  const [egress, setEgress] = useState(false);
  const [formError, setFormError] = useState('');
  const create = useMutation({
    mutationFn: (body: object) => api<HostedServerInfo>('/api/hosted', { method: 'POST', body }),
    onSuccess: () => { setName(''); setSlug(''); setSlugTouched(false); setImage(''); setEnvText(''); setSecretText(''); setEgress(false); void qc.invalidateQueries({ queryKey: ['hosted'] }); },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const env = parseEnv(envText); const secret = parseEnv(secretText);
    const err = env.error ?? (secret.error ? `secret ${secret.error}` : '');
    setFormError(err);
    if (err) return;
    create.mutate({ name: name.trim(), slug, image: image.trim(), port: Number(port), path, allowEgress: egress,
      ...(Object.keys(env.env).length ? { env: env.env } : {}), ...(Object.keys(secret.env).length ? { secretEnv: secret.env } : {}) });
  };
  return (
    <form className="card form" onSubmit={submit} aria-labelledby="addhosted-h">
      <h3 id="addhosted-h">Add by image</h3>
      <div className="row wrap align-end">
        <label className="grow"><span>Name</span>
          <input required maxLength={100} value={name} onChange={(e) => { setName(e.target.value); if (!slugTouched) setSlug(slugFrom(e.target.value)); }} /></label>
        <label className="grow"><span>Slug <span className="muted small">(tool prefix, fixed)</span></span>
          <input required minLength={3} maxLength={16} pattern="[a-z][a-z0-9\-]{1,14}[a-z0-9]" value={slug} onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }} /></label>
      </div>
      <label><span>Image <span className="muted small">(allowed: {registries.join(', ')}; a fixed tag or digest, not :latest)</span></span>
        <input required className="mono" placeholder={`${registries[0] ?? 'registry.example'}/owner/image:1.0.0`} value={image} onChange={(e) => setImage(e.target.value)} spellCheck={false} /></label>
      <div className="row wrap align-end">
        <label><span>Port</span><input required type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} /></label>
        <label className="grow"><span>MCP path</span><input required value={path} onChange={(e) => setPath(e.target.value)} /></label>
      </div>
      <label><span>Environment <span className="muted small">(one NAME=value per line)</span></span>
        <textarea rows={3} className="mono" value={envText} onChange={(e) => setEnvText(e.target.value)} spellCheck={false} /></label>
      <label><span>Secret environment <span className="muted small">(stored encrypted, never shown again)</span></span>
        <textarea rows={3} className="mono" value={secretText} onChange={(e) => setSecretText(e.target.value)} spellCheck={false} autoComplete="off" /></label>
      <label className="choice"><input type="checkbox" checked={egress} onChange={(e) => setEgress(e.target.checked)} /> Allow outbound HTTPS to the internet (never the cluster)</label>
      <div className="row">
        <button type="submit" disabled={create.isPending || atLimit}>{create.isPending ? 'Adding…' : 'Add server'}</button>
        {atLimit && <span className="muted small">Limit reached; delete one first.</span>}
      </div>
      {(formError || create.isError) && <p className="error" role="alert">{formError || create.error?.message}</p>}
    </form>
  );
}

function HostedCard({ s }: { s: HostedServerInfo }) {
  const qc = useQueryClient();
  const [typed, setTyped] = useState('');
  const [open, setOpen] = useState(false);
  const del = useMutation({
    mutationFn: () => api<HostedServerInfo>(`/api/hosted/${s.id}?confirm=${encodeURIComponent(typed)}`, { method: 'DELETE' }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['hosted'] }); void qc.invalidateQueries({ queryKey: ['upstreams'] }); },
  });
  return (
    <article className="card" aria-labelledby={`hosted-${s.id}`}>
      <div className="row between wrap">
        <div>
          <h3 id={`hosted-${s.id}`}>{s.name} <code className="muted small">{s.slug}</code></h3>
          <p className="muted small"><code>{s.image}</code> · port {s.port}{s.path} · added {when(s.createdAt)}</p>
        </div>
        <StoreStatusBadge status={s.status} />
      </div>
      {s.status === 'failed' && s.statusReason && <p className="error small" role="alert">Why it failed: {s.statusReason}</p>}
      {s.status === 'provisioning' && <p className="muted small">Pulling the image and starting it…</p>}
      <p className="small muted">
        {s.secretEnvNames.length > 0 && <>Secret variables: {s.secretEnvNames.map((n) => <code key={n}> {n}</code>)} · </>}
        {s.allowEgress ? 'outbound HTTPS allowed' : 'no outbound network'} · namespace <code>{s.namespace}</code>
      </p>
      {s.status !== 'deleting' && (
        <>
          <button type="button" className="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Delete…'}</button>
          {open && (
            <form onSubmit={(e) => { e.preventDefault(); del.mutate(); }} className="stack" style={{ marginTop: '0.5rem' }}>
              <p className="muted small">Removes the server, its namespace and its secrets, and its tools from the gateway. Type <code>{s.slug}</code> to confirm.</p>
              <div className="row wrap align-end">
                <label className="grow"><span className="sr-only">Type the slug to confirm</span><input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={s.slug} autoComplete="off" /></label>
                <button type="submit" className="danger" disabled={typed !== s.slug || del.isPending}>{del.isPending ? 'Deleting…' : 'Delete server'}</button>
              </div>
              {del.isError && <p className="error" role="alert">{del.error.message}</p>}
            </form>
          )}
        </>
      )}
    </article>
  );
}
