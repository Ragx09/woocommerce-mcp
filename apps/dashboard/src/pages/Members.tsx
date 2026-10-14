// UI-09: members and invitations (admin). Invite links are shown once with a copy button; nothing is
// emailed (A-03). Disabling a member signs them out everywhere and stops their API keys at once; the
// API refuses to disable or demote yourself or the last admin.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, type CreatedInvite, type Member, type OpenInvite, type Role } from '../api.js';
import { useMe } from '../auth.js';
import { SecretOnce, when } from '../components.js';

export function Members() {
  return (
    <section className="stack">
      <div>
        <h1>Members</h1>
        <p className="muted">Invite people, change roles, and disable access. Disabled members keep their history in the audit log.</p>
      </div>
      <InviteBox />
      <OpenInvites />
      <MemberTable />
    </section>
  );
}

function InviteBox() {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const create = useMutation({
    mutationFn: () => api<CreatedInvite>('/api/invites', { method: 'POST', body: { email: email.trim(), role } }),
    onSuccess: () => { setEmail(''); void qc.invalidateQueries({ queryKey: ['invites'] }); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };
  return (
    <form className="card form" onSubmit={submit} aria-labelledby="invite-h">
      <h2 id="invite-h">Invite a member</h2>
      <div className="row wrap align-end">
        <label className="grow">
          Email
          <input type="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <button type="submit" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create invite link'}</button>
      </div>
      {create.isError && <p className="error" role="alert">{create.error.message}</p>}
      {create.data && (
        <SecretOnce label={`Invite link for ${create.data.email}`} value={create.data.inviteUrl}
          note={`Send it to them yourself. It works once and expires ${new Date(create.data.expiresAt).toLocaleString()}. It is not shown again.`} />
      )}
    </form>
  );
}

function OpenInvites() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['invites'], queryFn: () => api<OpenInvite[]>('/api/invites') });
  const withdraw = useMutation({
    mutationFn: (id: string) => api<void>(`/api/invites/${id}`, { method: 'DELETE' }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['invites'] }),
  });
  if (!list.data?.length) return null;
  return (
    <div className="card">
      <h2>Open invites</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Email</th><th>Role</th><th>Created</th><th>Expires</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {list.data.map((i) => (
              <tr key={i.id}>
                <td>{i.email}</td><td>{i.role}</td><td>{when(i.createdAt)}</td><td>{new Date(i.expiresAt).toLocaleString()}</td>
                <td><button type="button" className="ghost" onClick={() => withdraw.mutate(i.id)} disabled={withdraw.isPending}>Withdraw</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {withdraw.isError && <p className="error" role="alert">{withdraw.error.message}</p>}
    </div>
  );
}

function MemberTable() {
  const me = useMe().data!;
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['users'], queryFn: () => api<Member[]>('/api/users') });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { disabled?: boolean; role?: Role } }) =>
      api<Member>(`/api/users/${id}`, { method: 'PATCH', body }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['users'] }); void qc.invalidateQueries({ queryKey: ['keys'] }); },
  });
  return (
    <div className="card">
      <h2>People</h2>
      {list.isPending && <p className="muted">Loading…</p>}
      {list.isError && <p className="error" role="alert">{list.error.message}</p>}
      {update.isError && <p className="error" role="alert">{update.error.message}</p>}
      {list.data && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Active keys</th><th>Last key use</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {list.data.map((u) => {
                const self = u.id === me.id;
                return (
                  <tr key={u.id} className={u.disabledAt ? 'dim' : ''}>
                    <td>{u.name}{self && <span className="muted small"> (you)</span>}</td>
                    <td>{u.email}</td>
                    <td><span className={`badge ${u.role}`}>{u.role}</span></td>
                    <td>{u.disabledAt ? <span className="error">Disabled</span> : 'Active'}</td>
                    <td>{u.activeKeys}</td>
                    <td>{when(u.lastKeyUseAt)}</td>
                    <td className="actions">
                      {!self && (
                        <>
                          <button type="button" className="ghost" disabled={update.isPending}
                            onClick={() => update.mutate({ id: u.id, body: { role: u.role === 'admin' ? 'member' : 'admin' } })}>
                            {u.role === 'admin' ? 'Make member' : 'Make admin'}
                          </button>
                          <button type="button" className={`ghost${u.disabledAt ? '' : ' danger'}`} disabled={update.isPending}
                            onClick={() => update.mutate({ id: u.id, body: { disabled: !u.disabledAt } })}>
                            {u.disabledAt ? 'Enable' : 'Disable'}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
