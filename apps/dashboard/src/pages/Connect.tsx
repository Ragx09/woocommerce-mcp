// BON-08: OAuth consent. An MCP client sent the browser to /oauth/authorize; the gateway checked the client and
// its redirect URI and parked the request, then sent the browser here with an opaque request id. The signed-in
// user approves or denies; the gateway answers with the URL to go back to (the client's registered redirect URI).
// The decision is a same-origin POST, so the session cookie (SameSite=Strict) and the Origin check guard it.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { api, type ConsentInfo } from '../api.js';

export function Connect() {
  const [params] = useSearchParams();
  const request = params.get('request') ?? '';
  const info = useQuery({
    queryKey: ['consent', request],
    queryFn: () => api<ConsentInfo>('/api/oauth/consent', { method: 'POST', body: { request } }),
    enabled: /^[A-Za-z0-9_-]{43}$/.test(request),
    retry: false,
    staleTime: Infinity,
  });
  const decide = useMutation({
    mutationFn: (approve: boolean) => api<{ redirect: string }>('/api/oauth/consent/decision', { method: 'POST', body: { request, approve } }),
    onSuccess: ({ redirect }) => window.location.assign(redirect),
  });

  return (
    <div className="center">
      <div className="card auth">
        <h1>Connect an app</h1>
        {!info.isFetching && !info.data && !info.isError && <p className="error" role="alert">This link is not a valid sign-in request. Start again from your MCP client.</p>}
        {info.isPending && info.isFetching && <p className="muted">Loading…</p>}
        {info.isError && <p className="error" role="alert">{info.error.message}</p>}
        {info.data && (
          <>
            <p>
              <strong>{info.data.client}</strong> wants to use the MCP gateway as <strong>{info.data.user.name}</strong>{' '}
              <span className="muted">({info.data.user.email})</span>.
            </p>
            <ul className="small">
              <li>It can list and call the tools you are allowed to use, until you revoke it on the API keys page.</li>
              <li>Every call is logged under your name.</li>
              <li>After you decide, your browser goes back to <code>{info.data.redirectTo}</code>.</li>
            </ul>
            <p className="muted small">The app chose its own name. Approve only if you started this sign-in yourself.</p>
            {decide.isError && <p className="error" role="alert">{decide.error.message}</p>}
            {decide.isSuccess ? <p className="muted">Returning to the app…</p> : (
              <div className="row">
                <button type="button" onClick={() => decide.mutate(true)} disabled={decide.isPending}>Approve</button>
                <button type="button" className="ghost" onClick={() => decide.mutate(false)} disabled={decide.isPending}>Deny</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
