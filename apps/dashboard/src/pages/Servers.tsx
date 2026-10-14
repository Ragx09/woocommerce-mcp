// UI-04: registered MCP servers with live status (refreshed every 10 s, like the gateway's health loop)
// and their tools on demand. Members see the same list without connection details (the API omits them).
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type ToolInfo, type Upstream, type UpstreamStatus } from '../api.js';
import { useMe } from '../auth.js';

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
        {list.data && <p className="muted small" aria-live="polite">{summary(list.data)}</p>}
      </div>
      {list.isPending && <p className="muted">Loading…</p>}
      {list.isError && <p className="error" role="alert">{list.error.message}</p>}
      {list.data?.length === 0 && <div className="card muted">No servers registered yet.</div>}
      {list.data?.map((u) => <ServerCard key={u.id} u={u} now={now} isAdmin={isAdmin} />)}
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
          <h2 id={`srv-${u.id}`}>{u.name} <code className="muted small">{u.slug}</code></h2>
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
        </dl>
      )}
      <button type="button" className="ghost" aria-expanded={open} onClick={() => setOpen(!open)} disabled={!canList}>
        {open ? 'Hide tools' : 'Show tools'}
      </button>
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
