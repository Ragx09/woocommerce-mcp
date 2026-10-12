// Database schema (Drizzle). Migrations are generated from this file: `npm run db:generate -w services/gateway`.
import { sql } from 'drizzle-orm';
import { boolean, check, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** AES-256-GCM ciphertext of an upstream credential (D-009). Never returned by the API. */
export interface EncryptedCredential {
  v: 1;
  iv: string; // base64, 12 bytes
  ciphertext: string; // base64
  tag: string; // base64, 16 bytes
}

export const AUTH_TYPES = ['none', 'header', 'bearer'] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

/** Registered upstream MCP servers. Runtime state (status, tools) lives in memory, not here. */
export const upstreams = pgTable(
  'upstreams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Tool-name prefix (`<slug>__<tool>`, D-005). Immutable after creation. */
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    url: text('url').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    authType: text('auth_type', { enum: AUTH_TYPES }).notNull().default('none'),
    /** Header name for authType=header, e.g. X-Internal-Token. Bearer uses Authorization. */
    authHeader: text('auth_header'),
    credentialEnc: jsonb('credential_enc').$type<EncryptedCredential>(),
    /** users.id once AUTH-01 lands; null for rows seeded at startup. */
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Bumped on every ORM update; the seeder uses it to tell admin edits from untouched seeded rows. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    // Constraints are enforced by the database too, not only by API validation.
    check('upstreams_slug_format', sql`${t.slug} ~ '^[a-z0-9-]{1,20}$'`),
    check('upstreams_name_length', sql`char_length(${t.name}) between 1 and 100`),
    check('upstreams_url_http', sql`${t.url} ~ '^https?://' and char_length(${t.url}) <= 2048`),
    check('upstreams_auth_type', sql`${t.authType} in ('none', 'header', 'bearer')`),
    check(
      'upstreams_auth_header',
      sql`(${t.authType} = 'header') = (${t.authHeader} is not null)
          and (${t.authHeader} is null or ${t.authHeader} ~ '^[A-Za-z0-9-]{1,64}$')`,
    ),
    check('upstreams_credential', sql`${t.authType} <> 'none' or ${t.credentialEnc} is null`),
  ],
);

export type Upstream = typeof upstreams.$inferSelect;

/** Small key/value store for one-time actions (e.g. "the woo upstream was seeded at …"). */
export const appMeta = pgTable('app_meta', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export type NewUpstream = typeof upstreams.$inferInsert;
