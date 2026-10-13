// Default-deny access policy for /api (AUTH-10, T-05). Every /api route must declare
// `config: { access: 'public' | 'session' | 'admin' }`; a route without one makes startup fail, so a new
// route cannot ship unguarded by accident. The guard is attached here, as the route's first onRequest
// hook: authentication and role run before the body is parsed or validated.
import type { FastifyInstance, onRequestHookHandler } from 'fastify';
import type { Db } from '../db/index.js';
import { requireRole, requireSession } from './guard.js';

export type Access = 'public' | 'session' | 'admin';

declare module 'fastify' {
  interface FastifyContextConfig { access?: Access }
}

export interface RouteAccess { method: string; url: string; access: Access }

const tables = new WeakMap<FastifyInstance, RouteAccess[]>();

/** The access policy of every /api route registered so far (for the authorization table test). */
export function accessTable(app: FastifyInstance): RouteAccess[] {
  return [...(tables.get(app) ?? [])];
}

/** Must be called before any /api route is registered. */
export function enforceAccessPolicy(app: FastifyInstance, db: Db): void {
  const table: RouteAccess[] = [];
  tables.set(app, table);
  const session = requireSession(db) as onRequestHookHandler;
  const admin = requireRole('admin') as onRequestHookHandler;
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/')) return;
    const access = route.config?.access;
    if (access !== 'public' && access !== 'session' && access !== 'admin') {
      throw new Error(`${String(route.method)} ${route.url}: every /api route needs config.access (public | session | admin)`);
    }
    for (const method of [route.method].flat()) if (method !== 'HEAD') table.push({ method, url: route.url, access });
    if (access === 'public') return;
    const existing = route.onRequest ? [route.onRequest].flat() : [];
    route.onRequest = [session, ...(access === 'admin' ? [admin] : []), ...existing];
  });
}
