// UI-04: registered MCP servers with live status (refreshed every 10 s, like the gateway's health loop)
// and their tools on demand. Members see the same list without connection details (the API omits them)
// and without the admin actions (UI-07/08: add, edit, disable/enable, delete — enforced by the API).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, type ToolInfo, type Upstream, type UpstreamStatus } from '../api.js';
import { useMe } from '../auth.js';
import { Hosted } from './Hosted.js';

const STATUS: Record<UpstreamStatus, string> = { connected: 'Connected', unreachable: 'Unreachable', disabled: 'Disabled', unknown: 'Checking…' };

export function StatusBadge({ status }: { status: UpstreamStatus }) {
  return <span className={`status ${status}`}><span className="dot" aria-hidden="true" />{STATUS[status]}</span>;
}

function ago(iso: string | null, now: number): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(iso).toLocaleString();
}

export function Servers() {
  const isAdmin = useMe().data?.role === 'admin';
  const list = useQuery({
    queryKey: ['upstreams'],
    queryFn: () => api<Upstream[]>('/api/upstreams'),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
  const now = list.dataUpdatedAt || Date.now();

  return (
    <section className="stack">
      <div className="row between">
        <div>
          <h1>Servers</h1>
          <p className="muted">MCP servers behind the gateway. Status refreshes every 10 seconds.</p>
        </div>
        <div className="stack-right">
          {isAdmin && <Link className="button" to="/servers/new">Add server</Link>}
          {list.data && <p className="muted small" aria-live="polite">{summary(list.data)}</p>}
        </div>
      </div>
      {list.isPending && <p className="muted">Loading…</p>}
      {list.isError && <p className="error" role="alert">{list.error.message}</p>}
      {list.data?.length === 0 && <div className="card muted">No servers registered yet.</div>}
      {list.data?.map((u) => <ServerCard key={u.id} u={u} now={now} isAdmin={isAdmin} />)}
      {isAdmin && <Hosted />}
    </section>
  );
}

function summary(list: Upstream[]): string {
  const n = (s: UpstreamStatus) => list.filter((u) => u.status === s).length;
  const tools = list.reduce((a, u) => a + (u.toolCount ?? 0), 0);
  return `${n('connected')} connected · ${n('unreachable')} unreachable · ${n('disabled')} disabled · ${tools} tools`;
}

function ServerCard({ u, now, isAdmin }: { u: Upstream; now: number; isAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const canList = u.enabled && u.status !== 'unreachable';
  return (
    <article className={`card server ${u.status}`} aria-labelledby={`srv-${u.id}`}>
      <div className="row between wrap">
        <div>
          <h2 id={`srv-${u.id}`}>{u.name} <code className="muted small">{u.slug}</code>{u.kind === 'hosted' && <> <span className="badge">hosted</span></>}{u.kind === 'store' && <> <span className="badge">store</span></>}</h2>
          <p className="muted small">
            {u.toolCount === null ? 'Tools unknown' : `${u.toolCount} tool${u.toolCount === 1 ? '' : 's'}`} · checked {ago(u.lastCheckedAt, now)}
            {u.status !== 'connected' && u.lastOkAt ? ` · last OK ${ago(u.lastOkAt, now)}` : ''}
          </p>
        </div>
        <StatusBadge status={u.status} />
      </div>
      {u.lastError && (
        <p className={`small ${u.status === 'unreachable' ? 'error' : 'muted'}`}>
          {u.status === 'unreachable' ? 'Error: ' : 'Last error: '}{u.lastError}
        </p>
      )}
      {isAdmin && u.url && (
        <dl className="kv small">
          <dt>URL</dt>
          <dd><code>{u.url}</code></dd>
          <dt>Auth</dt>
          <dd>{u.authType === 'none' ? 'none' : `${u.authType}${u.authHeader ? ` (${u.authHeader})` : ''}, ${u.hasCredential ? 'credential stored (encrypted, never shown)' : 'no credential'}`}</dd>
          <dt>Members</dt>
          <dd>{memberAccessText(u)}</dd>
          {u.stats && (
            <>
              <dt>Last {u.stats.windowMinutes === 60 ? 'hour' : `${u.stats.windowMinutes} min`}</dt>
              <dd>{statsText(u.stats)}</dd>
            </>
          )}
        </dl>
      )}
      <div className="row wrap">
        <button type="button" className="ghost" aria-expanded={open} onClick={() => setOpen(!open)} disabled={!canList}>
          {open ? 'Hide tools' : 'Show tools'}
        </button>
        {isAdmin && <AdminActions u={u} />}
      </div>
      {open && canList && <ToolList id={u.id} />}
    </article>
  );
}

function ToolList({ id }: { id: string }) {
  const tools = useQuery({ queryKey: ['upstream-tools', id], queryFn: () => api<ToolInfo[]>(`/api/upstreams/${id}/tools`), staleTime: 60_000 });
  if (tools.isPending) return <p className="muted small">Loading tools…</p>;
  if (tools.isError) return <p className="error small" role="alert">{tools.error.message}</p>;
  if (tools.data.length === 0) return <p className="muted small">This server has no tools.</p>;
  return (
    <ul className="tools">
      {tools.data.map((t) => (
        <li key={t.publicName}>
          <code className="tool-name">{t.publicName}</code>
          {t.title && <span className="muted small"> — {t.title}</span>}
          {t.description && <p className="small">{t.description}</p>}
          {t.params.length > 0 && (
            <p className="muted small">
              Parameters: {t.params.map((p, i) => <span key={p.name}>{i > 0 && ', '}<code>{p.name}</code>{p.required && '*'}</span>)}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** UI-06/07: edit, enable/disable, delete (two-step confirm in the page, no browser dialog). */
function AdminActions({ u }: { u: Upstream }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const done = () => void qc.invalidateQueries({ queryKey: ['upstreams'] });
  const toggle = useMutation({
    mutationFn: () => api<Upstream>(`/api/upstreams/${u.id}`, { method: 'PATCH', body: { enabled: !u.enabled } }),
    onSuccess: done,
  });
  const remove = useMutation({ mutationFn: () => api<void>(`/api/upstreams/${u.id}`, { method: 'DELETE' }), onSuccess: done });
  const error = toggle.error ?? remove.error;
  return (
    <>
      <Link className="button ghost" to={`/servers/${u.id}/edit`}>Edit</Link>
      <button type="button" className="ghost" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
        {u.enabled ? 'Disable' : 'Enable'}
      </button>
      {!confirming
        ? <button type="button" className="ghost danger" onClick={() => setConfirming(true)}>Delete</button>
        : (
          <span className="confirm" role="group" aria-label={`Delete ${u.name}?`}>
            <span className="small">Delete {u.name}? Its tools disappear for everyone.</span>
            <button type="button" className="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
              {remove.isPending ? 'Deleting…' : 'Delete'}
            </button>
            <button type="button" className="ghost" onClick={() => setConfirming(false)}>Cancel</button>
          </span>
        )}
      {error && <span className="error small" role="alert">{error.message}</span>}
    </>
  );
}

/** BON-01: what members may use on this server, for the admin's card. */
function memberAccessText(u: Upstream): string {
  if (u.memberAccess === 'none') return 'no access (hidden from members)';
  if (u.memberAccess === 'selected') {
    const t = u.memberTools ?? [];
    return t.length ? `only ${t.join(', ')}` : 'no tools selected (members see none)';
  }
  return 'all tools';
}

/** BON-03: "12 calls · 1 failed (8%) · p95 340 ms · 2 refused". */
function statsText(s: NonNullable<Upstream['stats']>): string {
  if (s.calls === 0) return 'no calls';
  const ran = s.calls - s.rejected;
  const parts = [`${s.calls} call${s.calls === 1 ? '' : 's'}`];
  if (ran > 0) parts.push(`${s.failed} failed (${Math.round((100 * s.failed) / ran)}%)`);
  if (s.p95Ms !== null) parts.push(`p95 ${s.p95Ms < 1000 ? `${s.p95Ms} ms` : `${(s.p95Ms / 1000).toFixed(1)} s`}`);
  if (s.rejected) parts.push(`${s.rejected} refused`);
  return parts.join(' · ');
}
