// /invite#<token>: the token sits in the URL fragment, which browsers never send to a server, so it
// stays out of access logs (AUTH-04). It is read once, then removed from the address bar and history.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, type InviteInfo, type Me } from '../api.js';
import { meKey } from '../auth.js';

const MIN_PASSWORD = 12;

function takeToken(): string {
  const token = decodeURIComponent(window.location.hash.slice(1));
  if (token) window.history.replaceState(window.history.state, '', window.location.pathname);
  return token;
}

export function Invite() {
  const [token] = useState(takeToken);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState('');

  const check = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api<InviteInfo>('/api/invites/check', { method: 'POST', body: { token } }),
    enabled: token !== '',
    staleTime: Infinity,
    retry: false,
  });
  const accept = useMutation({
    mutationFn: () => api<{ user: Me }>('/api/invites/accept', { method: 'POST', body: { token, name, password } }),
    onSuccess: ({ user }) => {
      qc.setQueryData(meKey, user);
      navigate('/', { replace: true });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password.length < MIN_PASSWORD) return setLocalError(`Use at least ${MIN_PASSWORD} characters.`);
    if (password !== confirm) return setLocalError('The passwords do not match.');
    setLocalError('');
    accept.mutate();
  };

  let body;
  if (!token) body = <p className="error">This link has no invite token. Open the full link you were sent.</p>;
  else if (check.isPending) body = <p className="muted">Checking your invite…</p>;
  else if (check.isError) body = <p className="error" role="alert">{check.error.message}</p>;
  else {
    const inv = check.data;
    body = (
      <>
        <p>
          You were invited as <strong>{inv.email}</strong> ({inv.role}). The invite expires {new Date(inv.expiresAt).toLocaleString()}.
        </p>
        <label>
          Your name
          <input required maxLength={100} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <input type="email" autoComplete="username" value={inv.email} readOnly hidden />
        <label>
          <span>Password <span className="muted small">(at least {MIN_PASSWORD} characters)</span></span>
          <input type="password" required minLength={MIN_PASSWORD} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label>
          Repeat password
          <input type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        {(localError || accept.isError) && <p className="error" role="alert">{localError || accept.error?.message}</p>}
        <button type="submit" disabled={accept.isPending}>{accept.isPending ? 'Creating account…' : 'Create account'}</button>
      </>
    );
  }
  return (
    <div className="center">
      <form className="card auth" onSubmit={submit}>
        <h1>Accept invite</h1>
        {body}
        <p className="muted small"><Link to="/login">Already have an account? Sign in</Link></p>
      </form>
    </div>
  );
}
