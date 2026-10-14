// UI-12: audit log (admin): who called which tool on which server, when, how long, and the outcome.
// Newest first, refreshed every 10 s; filters map 1:1 to GET /api/audit query parameters. Arguments
// and results are never stored, so they cannot be shown here.
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type AuditOutcome, type AuditPage, type Member, type Upstream } from '../api.js';

const OUTCOMES: AuditOutcome[] = ['ok', 'tool_error', 'error', 'timeout', 'unreachable', 'rejected', 'denied'];
const PAGE = 50;

export function Audit() {
  const [user, setUser] = useState('');
  const [upstream, setUpstream] = useState('');
  const [outcome, setOutcome] = useState('');
  const [source, setSource] = useState('');
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<Member[]>('/api/users') });
  const servers = useQuery({ queryKey: ['upstreams'], queryFn: () => api<Upstream[]>('/api/upstreams') });
  const filters = { user, upstream, outcome, source };
  const log = useInfiniteQuery({
    queryKey: ['audit', filters],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: String(PAGE) });
      for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
      if (pageParam) q.set('cursor', pageParam);
      return api<AuditPage>(`/api/audit?${q}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
  const items = log.data?.pages.flatMap((p) => p.items) ?? [];
  const anyFilter = Object.values(filters).some(Boolean);

  return (
    <section className="stack">
      <div className="row between wrap">
        <div>
          <h1>Audit log</h1>
          <p className="muted">Every MCP call through the gateway, from external clients and the chat. Refreshes every 10 seconds.</p>
        </div>
        {log.dataUpdatedAt > 0 && <p className="muted small" aria-live="polite">Updated {new Date(log.dataUpdatedAt).toLocaleTimeString()}</p>}
      </div>
      <div className="card row wrap align-end filters" role="search" aria-label="Filter the audit log">
        <label>
          User
          <select value={user} onChange={(e) => setUser(e.target.value)}>
            <option value="">Everyone</option>
            {users.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
        <label>
          Server
          <select value={upstream} onChange={(e) => setUpstream(e.target.value)}>
            <option value="">All servers</option>
            {servers.data?.map((s) => <option key={s.id} value={s.slug}>{s.name}</option>)}
          </select>
        </label>
        <label>
          Outcome
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="">Any</option>
            {OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
        <label>
          Source
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">Any</option>
            <option value="mcp">MCP client</option>
            <option value="chat">Chat</option>
          </select>
        </label>
        {anyFilter && <button type="button" className="ghost" onClick={() => { setUser(''); setUpstream(''); setOutcome(''); setSource(''); }}>Clear</button>}
      </div>
      {log.isError && <p className="error" role="alert">{log.error.message}</p>}
      <div className="card">
        {log.isPending && <p className="muted">Loading…</p>}
        {log.data && items.length === 0 && <p className="muted">{anyFilter ? 'No calls match these filters.' : 'No calls yet.'}</p>}
        {items.length > 0 && (
          <div className="table-wrap">
            <table className="audit">
              <thead>
                <tr><th>Time</th><th>User</th><th>Source</th><th>Server</th><th>Tool / method</th><th className="num">Duration</th><th>Outcome</th></tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id}>
                    <td title={a.requestId ? `request id ${a.requestId}` : undefined}>{new Date(a.ts).toLocaleString()}</td>
                    <td title={a.user?.email}>{a.user?.name ?? <span className="muted">unknown key</span>}{a.keyPrefix && <code className="muted small"> {a.keyPrefix}…</code>}</td>
                    <td>{a.source === 'chat' ? 'Chat' : 'MCP'}</td>
                    <td>{a.upstream ?? '—'}</td>
                    <td><code>{a.tool ?? a.method}</code></td>
                    <td className="num">{a.durationMs} ms</td>
                    <td><span className={`outcome ${a.outcome}`}>{a.outcome}</span>{a.errorCode && <span className="muted small"> {a.errorCode}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {log.hasNextPage && (
          <button type="button" className="ghost" onClick={() => void log.fetchNextPage()} disabled={log.isFetchingNextPage}>
            {log.isFetchingNextPage ? 'Loading…' : 'Load older'}
          </button>
        )}
      </div>
    </section>
  );
}
