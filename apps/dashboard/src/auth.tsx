// Who is signed in. The server is the authority: GET /api/me answers with the session's user or 401.
// The UI only uses the role to decide what to show; every /api route enforces it again (AUTH-10).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { ApiError, api, setUnauthenticatedHandler, type Me } from './api.js';
import { chatStore } from './chat.js';

export const meKey = ['me'] as const;

export function useMe() {
  return useQuery({
    queryKey: meKey,
    queryFn: async () => {
      try {
        return await api<Me>('/api/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null; // signed out is an answer, not an error
        throw e;
      }
    },
    staleTime: 60_000,
  });
}

/** A request found the session gone: forget everything cached and go to /login (back here afterwards). */
export function useSessionExpiry(): void {
  const qc = useQueryClient();
  const navigate = useNavigate();
  useEffect(() => {
    setUnauthenticatedHandler(() => {
      const here = window.location.pathname + window.location.search;
      qc.clear();
      qc.setQueryData(meKey, null);
      chatStore.reset(null);
      if (!here.startsWith('/login') && !here.startsWith('/invite')) navigate(`/login?next=${encodeURIComponent(here)}`, { replace: true });
    });
  }, [qc, navigate]);
}

export function useLogout() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => api<void>('/api/auth/logout', { method: 'POST' }),
    onSettled: () => {
      chatStore.reset(null);
      qc.clear();
      qc.setQueryData(meKey, null);
      navigate('/login', { replace: true });
    },
  });
}

/** Only for in-app paths: an absolute or protocol-relative `next` would be an open redirect. */
export function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

export function RequireAuth({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  const me = useMe();
  const loc = useLocation();
  if (me.isPending) return <p className="muted pad">Loading…</p>;
  if (me.isError) return <p className="error pad">{me.error.message}</p>;
  if (!me.data) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (admin && me.data.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}
