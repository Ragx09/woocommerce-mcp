// /api/keys and /api/users/:id/keys (AUTH-06/09, docs/API_CONTRACTS.md).
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/index.js';
import { createApiKey, KeyError, listApiKeys, revokeApiKey } from './api-keys.js';
import { requireRole, requireSession } from './guard.js';

const nameBody = { type: 'object', required: ['name'], additionalProperties: false,
  properties: { name: { type: 'string', minLength: 1, maxLength: 100 } } } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;

function fail(reply: FastifyReply, e: unknown) {
  if (e instanceof KeyError) return reply.code(e.status).send({ error: e.code, message: e.message });
  throw e;
}

export function registerKeyRoutes(app: FastifyInstance, db: Db): void {
  const session = requireSession(db);

  // Own keys; an admin adds ?all=1 for everyone's. Never a hash or a full key.
  app.get<{ Querystring: { all?: string } }>('/api/keys', {
    preHandler: session,
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { all: { type: 'string', enum: ['0', '1'] } } } },
  }, async (req, reply) => {
    if (req.query.all === '1' && req.user!.role !== 'admin') {
      return reply.code(403).send({ error: 'forbidden', message: 'not allowed for your role' });
    }
    return listApiKeys(db, req.query.all === '1' ? {} : { userId: req.user!.id });
  });

  // Generate an own key: the plaintext is in this response only.
  app.post<{ Body: { name: string } }>('/api/keys', { preHandler: session, schema: { body: nameBody } }, async (req, reply) => {
    try {
      const k = await createApiKey(db, req.user!.id, req.body.name.trim() || 'key', req.user!.id);
      req.log.info({ keyId: k.id, prefix: k.prefix, owner: req.user!.id }, 'api key created');
      return reply.code(201).send(k);
    } catch (e) { return fail(reply, e); }
  });

  // Admin issues a key for a user.
  app.post<{ Params: { id: string }; Body: { name: string } }>('/api/users/:id/keys', {
    preHandler: [session, requireRole('admin')], schema: { params: idParams, body: nameBody },
  }, async (req, reply) => {
    try {
      const k = await createApiKey(db, req.params.id, req.body.name.trim() || 'key', req.user!.id);
      req.log.info({ keyId: k.id, prefix: k.prefix, owner: req.params.id, by: req.user!.id }, 'api key issued');
      return reply.code(201).send(k);
    } catch (e) { return fail(reply, e); }
  });

  // Revoke: owner or admin. Takes effect on the next /mcp request (no cache).
  app.delete<{ Params: { id: string } }>('/api/keys/:id', { preHandler: session, schema: { params: idParams } }, async (req, reply) => {
    try {
      await revokeApiKey(db, req.params.id, req.user!);
      req.log.info({ keyId: req.params.id, by: req.user!.id }, 'api key revoked');
      return reply.code(204).send();
    } catch (e) { return fail(reply, e); }
  });
}
