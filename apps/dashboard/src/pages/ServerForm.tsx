// UI-05 / UI-06: add or edit an MCP server (admin). The credential is write-only: the form never
// receives it, only `hasCredential`; leaving the field empty on edit keeps the stored one. The server
// validates everything again (slug format, SSRF guard on the URL, auth/credential combinations).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, type Upstream } from '../api.js';

type AuthType = 'none' | 'bearer' | 'header';
const SLUG_RE = /^[a-z0-9-]{1,20}$/;

export function ServerForm() {
  const { id } = useParams();
  const existing = useQuery({
    queryKey: ['upstreams'],
    queryFn: () => api<Upstream[]>('/api/upstreams'),
    enabled: !!id,
    select: (list) => list.find((u) => u.id === id),
  });
  if (id && existing.isPending) return <p className="muted">Loading…</p>;
  if (id && existing.isError) return <p className="error" role="alert">{existing.error.message}</p>;
  if (id && !existing.data) return <section><h1>Server not found</h1><Link to="/servers">Back to servers</Link></section>;
  return <Form key={id ?? 'new'} existing={existing.data} />;
}

function Form({ existing }: { existing?: Upstream }) {
  const editing = !!existing;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(existing?.name ?? '');
  const [slug, setSlug] = useState(existing?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(editing);
  const [url, setUrl] = useState(existing?.url ?? '');
  const [authType, setAuthType] = useState<AuthType>(existing?.authType ?? 'none');
  const [authHeader, setAuthHeader] = useState(existing?.authHeader ?? '');
  const [credential, setCredential] = useState('');
  const [localError, setLocalError] = useState('');
  const hadCredential = !!existing?.hasCredential;

  const save = useMutation({
    mutationFn: () => {
      const auth = { authType, ...(authType === 'header' ? { authHeader: authHeader.trim() } : {}), ...(credential ? { credential } : {}) };
      if (!editing) return api<Upstream>('/api/upstreams', { method: 'POST', body: { name: name.trim(), slug, url: url.trim(), ...auth } });
      const body: Record<string, unknown> = {};
      if (name.trim() !== existing.name) body.name = name.trim();
      if (url.trim() !== existing.url) body.url = url.trim();
      if (authType !== existing.authType || (authType === 'header' && authHeader.trim() !== existing.authHeader) || credential) Object.assign(body, auth);
      if (Object.keys(body).length === 0) return Promise.resolve(existing);
      return api<Upstream>(`/api/upstreams/${existing.id}`, { method: 'PATCH', body });
    },
    onSuccess: () => {
      setCredential('');
      void qc.invalidateQueries({ queryKey: ['upstreams'] });
      void qc.invalidateQueries({ queryKey: ['upstream-tools'] });
      navigate('/servers');
    },
  });

  const onName = (v: string) => {
    setName(v);
    if (!slugTouched) setSlug(v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!editing && !SLUG_RE.test(slug)) return setLocalError('Slug: 1–20 characters, lower-case letters, digits and "-".');
    const needsSecret = authType !== 'none' && !credential && !(hadCredential && existing?.authType !== 'none');
    if (needsSecret) return setLocalError('This auth type needs a credential.');
    setLocalError('');
    save.mutate();
  };

  return (
    <section className="stack narrow">
      <div>
        <h1>{editing ? `Edit ${existing.name}` : 'Add server'}</h1>
        <p className="muted">
          {editing ? 'Changes apply to every client on its next request.' : 'Register a remote MCP server (Streamable HTTP). Its tools become available to the whole team as '}
          {!editing && <code>{slug || '<slug>'}__&lt;tool&gt;</code>}{!editing && '.'}
        </p>
      </div>
      <form className="card form" onSubmit={submit}>
        <label>
          Name
          <input required maxLength={100} value={name} onChange={(e) => onName(e.target.value)} autoFocus />
        </label>
        <label>
          <span>Slug <span className="muted small">(tool-name prefix; cannot be changed later)</span></span>
          <input required value={slug} readOnly={editing} pattern="[a-z0-9\-]{1,20}" maxLength={20}
            onChange={(e) => { setSlugTouched(true); setSlug(e.target.value); }} aria-readonly={editing} />
        </label>
        <label>
          <span>URL <span className="muted small">(the server's MCP endpoint, e.g. https://example.com/mcp)</span></span>
          <input required type="url" maxLength={2048} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
        </label>
        <fieldset>
          <legend>Authentication</legend>
          <div className="choices">
            {(['none', 'bearer', 'header'] as const).map((t) => (
              <label key={t} className="choice">
                <input type="radio" name="authType" value={t} checked={authType === t} onChange={() => setAuthType(t)} />
                {t === 'none' ? 'None' : t === 'bearer' ? 'Bearer token' : 'Custom header'}
              </label>
            ))}
          </div>
          {authType === 'header' && (
            <label>
              Header name
              <input required pattern="[A-Za-z0-9\-]{1,64}" maxLength={64} value={authHeader} onChange={(e) => setAuthHeader(e.target.value)} placeholder="X-Api-Key" />
            </label>
          )}
          {authType !== 'none' && (
            <label>
              <span>
                {authType === 'bearer' ? 'Token' : 'Header value'}{' '}
                <span className="muted small">
                  {hadCredential && existing?.authType !== 'none' ? '(stored, encrypted; leave empty to keep it)' : '(stored encrypted, never shown again)'}
                </span>
              </span>
              <input type="password" autoComplete="off" spellCheck={false} maxLength={4096} value={credential}
                onChange={(e) => setCredential(e.target.value)} placeholder={hadCredential && existing?.authType !== 'none' ? '••••••••' : ''} />
            </label>
          )}
        </fieldset>
        {(localError || save.isError) && <p className="error" role="alert">{localError || save.error?.message}</p>}
        <div className="row">
          <button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Add server'}</button>
          <Link to="/servers">Cancel</Link>
        </div>
      </form>
    </section>
  );
}
