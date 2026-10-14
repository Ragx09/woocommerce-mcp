// UI-11: my API keys (everyone) and UI-10: all keys (admin). A new key is shown exactly once; the
// gateway stores only its hash, so a lost key is revoked and replaced, never recovered. Revocation is
// effective on the client's next /mcp request.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, type ApiKeyInfo, type CreatedKey, type Member } from '../api.js';
import { useMe } from '../auth.js';
import { SecretOnce, when } from '../components.js';

export function Keys() {
  const isAdmin = useMe().data?.role === 'admin';
  return (
    <section className="stack">
      <div>
        <h1>API keys</h1>
        <p className="muted">
          An MCP client (Claude Code, Cursor, MCP Inspector) connects to <code>{window.location.origin}/mcp</code> with
          the header <code>Authorization: Bearer &lt;key&gt;</code>. Every call is logged under your name.
        </p>
      </div>
      <NewKey />
      <KeyTable scope="mine" />
      {isAdmin && <AdminKeys />}
    </section>
  );
}

function NewKey() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api<CreatedKey>('/api/keys', { method: 'POST', body: { name: name.trim() } }),
    onSuccess: () => { setName(''); void qc.invalidateQueries({ queryKey: ['keys'] }); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };
  return (
    <form className="card form" onSubmit={submit} aria-labelledby="newkey-h">
      <h2 id="newkey-h">Create a key</h2>
      <div className="row wrap align-end">
        <label className="grow">
          <span>Name <span className="muted small">(where you will use it, e.g. "laptop – Claude Code")</span></span>
          <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="submit" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create key'}</button>
      </div>
      {create.isError && <p className="error" role="alert">{create.error.message}</p>}
      {create.data && (
        <SecretOnce label={`Your new key "${create.data.name}"`} value={create.data.key}
          note="Copy it now: it is shown only once and cannot be recovered. If you lose it, revoke it and create a new one." />
      )}
    </form>
  );
}

function KeyTable({ scope }: { scope: 'mine' | 'all' }) {
  const qc = useQueryClient();
  const [showRevoked, setShowRevoked] = useState(false);
  const list = useQuery({ queryKey: ['keys', scope], queryFn: () => api<ApiKeyInfo[]>(scope === 'all' ? '/api/keys?all=1' : '/api/keys') });
  const revoke = useMutation({
    mutationFn: (id: string) => api<void>(`/api/keys/${id}`, { method: 'DELETE' }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['keys'] }); void qc.invalidateQueries({ queryKey: ['users'] }); },
  });
  const rows = (list.data ?? []).filter((k) => showRevoked || !k.revokedAt);
  const revokedCount = (list.data ?? []).filter((k) => k.revokedAt).length;
  return (
    <div className="card">
      <div className="row between wrap">
        <h2>{scope === 'all' ? 'All keys (everyone)' : 'My keys'}</h2>
        {revokedCount > 0 && (
          <label className="choice small">
            <input type="checkbox" checked={showRevoked} onChange={(e) => setShowRevoked(e.target.checked)} /> Show revoked ({revokedCount})
          </label>
        )}
      </div>
      {list.isPending && <p className="muted">Loading…</p>}
      {list.isError && <p className="error" role="alert">{list.error.message}</p>}
      {revoke.isError && <p className="error" role="alert">{revoke.error.message}</p>}
      {list.data && rows.length === 0 && <p className="muted">{scope === 'all' ? 'No active keys.' : 'You have no active keys yet.'}</p>}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>{scope === 'all' && <th>Owner</th>}<th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              {rows.map((k) => (
                <tr key={k.id} className={k.revokedAt ? 'dim' : ''}>
                  {scope === 'all' && <td title={k.owner.email}>{k.owner.name}</td>}
                  <td>{k.name}</td>
                  <td><code>{k.prefix}…</code></td>
                  <td>{when(k.createdAt)}</td>
                  <td>{k.lastUsedAt ? when(k.lastUsedAt) : 'never'}</td>
                  <td>{k.revokedAt ? `Revoked ${when(k.revokedAt)}` : 'Active'}</td>
                  <td>{!k.revokedAt && (
                    <button type="button" className="ghost danger" onClick={() => revoke.mutate(k.id)} disabled={revoke.isPending}
                      aria-label={`Revoke ${k.name}${scope === 'all' ? ` of ${k.owner.name}` : ''}`}>Revoke</button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** UI-10: issue a key for someone (e.g. a shared CI client) and manage everyone's keys. */
function AdminKeys() {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<Member[]>('/api/users') });
  const [userId, setUserId] = useState('');
  const [name, setName] = useState('');
  const issue = useMutation({
    mutationFn: () => api<CreatedKey>(`/api/users/${userId}/keys`, { method: 'POST', body: { name: name.trim() } }),
    onSuccess: () => { setName(''); void qc.invalidateQueries({ queryKey: ['keys'] }); void qc.invalidateQueries({ queryKey: ['users'] }); },
  });
  const active = (users.data ?? []).filter((u) => !u.disabledAt);
  const owner = active.find((u) => u.id === userId);
  const submit = (e: FormEvent) => { e.preventDefault(); issue.mutate(); };
  return (
    <>
      <form className="card form" onSubmit={submit} aria-labelledby="issue-h">
        <h2 id="issue-h">Issue a key for a member</h2>
        <div className="row wrap align-end">
          <label>
            Member
            <select required value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Choose…</option>
              {active.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
            </select>
          </label>
          <label className="grow">
            Key name
            <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <button type="submit" disabled={issue.isPending}>{issue.isPending ? 'Issuing…' : 'Issue key'}</button>
        </div>
        {issue.isError && <p className="error" role="alert">{issue.error.message}</p>}
        {issue.data && (
          <SecretOnce label={`Key "${issue.data.name}"${owner ? ` for ${owner.name}` : ''}`} value={issue.data.key}
            note="Hand it over securely. It is shown only once; calls made with it are logged under that member." />
        )}
      </form>
      <KeyTable scope="all" />
    </>
  );
}
