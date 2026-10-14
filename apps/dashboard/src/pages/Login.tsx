import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { api, type Me } from '../api.js';
import { meKey, safeNext, useMe } from '../auth.js';

export function Login() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => api<{ user: Me }>('/api/auth/login', { method: 'POST', body: { email, password } }),
    onSuccess: ({ user }) => {
      qc.setQueryData(meKey, user);
      navigate(next, { replace: true });
    },
    onError: () => setPassword(''),
  });

  if (me.data) return <Navigate to={next} replace />;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };
  return (
    <div className="center">
      <form className="card auth" onSubmit={submit}>
        <h1>Sign in</h1>
        <p className="muted">MCP Gateway dashboard</p>
        <label>
          Email
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {login.isError && <p className="error" role="alert">{login.error.message}</p>}
        <button type="submit" disabled={login.isPending}>{login.isPending ? 'Signing in…' : 'Sign in'}</button>
        <p className="muted small">No account? Ask an admin for an invite link.</p>
      </form>
    </div>
  );
}
