// Database schema (Drizzle). Migrations are generated from this file: `npm run db:generate -w services/gateway`.
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** AES-256-GCM ciphertext of an upstream credential (D-009). Never returned by the API. */
export interface EncryptedCredential {
  v: 1;
  iv: string; // base64, 12 bytes
  ciphertext: string; // base64
  tag: string; // base64, 16 bytes
}

export const AUTH_TYPES = ['none', 'header', 'bearer'] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

export const MEMBER_ACCESS = ['all', 'none', 'selected'] as const;
export type MemberAccess = (typeof MEMBER_ACCESS)[number];

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
    /** BON-01: which of its tools members may list and call (admins: all). 'selected' → `memberTools`. */
    memberAccess: text('member_access', { enum: MEMBER_ACCESS }).notNull().default('all'),
    /** Upstream tool names (not public names) members may use when memberAccess = 'selected'. */
    memberTools: jsonb('member_tools').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** The admin who added it; null for rows seeded at startup (or when that user is gone). */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
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
    check('upstreams_member_access', sql`${t.memberAccess} in ('all', 'none', 'selected')`),
    check('upstreams_member_tools', sql`jsonb_typeof(${t.memberTools}) = 'array' and jsonb_array_length(${t.memberTools}) <= 200`),
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

// ---- Users, sessions, invites, API keys, audit (AUTH-01, D-007, D-008, docs/MCP_DESIGN.md §9) ----
// Secrets are never stored: passwords as argon2id hashes, session/invite tokens and API keys as SHA-256
// hashes of high-entropy random values (lookup by hash, D-008).

export const ROLES = ['admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

const sha256Hex = (col: unknown) => sql`${col} ~ '^[0-9a-f]{64}$'`;

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stored lower-case, so uniqueness is case-insensitive. */
    email: text('email').notNull().unique(),
    name: text('name').notNull(),
    role: text('role', { enum: ROLES }).notNull().default('member'),
    /** argon2id PHC string. */
    passwordHash: text('password_hash').notNull(),
    /** Set → cannot log in, sessions and keys stop working. Users are disabled, never deleted (audit). */
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    check('users_email_format', sql`${t.email} = lower(${t.email}) and ${t.email} ~ '^[^@[:space:]]+@[^@[:space:]]+$' and char_length(${t.email}) <= 254`),
    check('users_name_length', sql`char_length(${t.name}) between 1 and 100`),
    check('users_role', sql`${t.role} in ('admin', 'member')`),
    check('users_password_hash', sql`${t.passwordHash} like '$argon2id$%'`),
  ],
);
export type User = typeof users.$inferSelect;

/** Dashboard sessions (D-007). The cookie holds a random token; the row is keyed by its SHA-256. */
export const sessions = pgTable(
  'sessions',
  {
    idHash: text('id_hash').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('sessions_id_hash', sha256Hex(t.idHash)),
    check('sessions_expiry', sql`${t.expiresAt} > ${t.createdAt}`),
    index('sessions_user_idx').on(t.userId),
    index('sessions_expires_idx').on(t.expiresAt),
  ],
);
export type Session = typeof sessions.$inferSelect;

/** One-time invite links (A-03: shown to the admin, no email). 72 h expiry. */
export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull().unique(),
    email: text('email').notNull(),
    role: text('role', { enum: ROLES }).notNull().default('member'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set when accepted; a used invite can never be used again (410). */
    usedAt: timestamp('used_at', { withTimezone: true }),
    usedBy: uuid('used_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    check('invites_token_hash', sha256Hex(t.tokenHash)),
    check('invites_email_format', sql`${t.email} = lower(${t.email}) and ${t.email} ~ '^[^@[:space:]]+@[^@[:space:]]+$' and char_length(${t.email}) <= 254`),
    check('invites_role', sql`${t.role} in ('admin', 'member')`),
    check('invites_expiry', sql`${t.expiresAt} > ${t.createdAt}`),
    check('invites_used', sql`${t.usedBy} is null or ${t.usedAt} is not null`), // used_by may be nulled later
  ],
);
export type Invite = typeof invites.$inferSelect;

/** Gateway API keys (D-008): `mgw_` + 32 random bytes base62; only the hash and a display prefix are kept. */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull().unique(),
    /** First 12 characters (`mgw_` + 8), enough to recognise a key in the UI, useless to an attacker. */
    prefix: text('prefix').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    check('api_keys_key_hash', sha256Hex(t.keyHash)),
    check('api_keys_prefix', sql`${t.prefix} ~ '^mgw_[A-Za-z0-9]{8}$'`),
    check('api_keys_name_length', sql`char_length(${t.name}) between 1 and 100`),
    index('api_keys_user_idx').on(t.userId),
  ],
);
export type ApiKey = typeof apiKeys.$inferSelect;

export const AUDIT_SOURCES = ['mcp', 'chat'] as const;
/** ok, the tool's own isError, gateway/upstream error, timeout, unreachable, rejected (unknown tool, disabled), denied (auth). */
export const AUDIT_OUTCOMES = ['ok', 'tool_error', 'error', 'timeout', 'unreachable', 'rejected', 'denied'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/**
 * One row per tools/call and per tools/list request, and per rejected /mcp request (docs/MCP_DESIGN.md §9).
 * Arguments and results are never stored. Upstream and user are kept as text/ids without hard links where
 * the row must outlive them (a removed upstream keeps its slug here).
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    requestId: uuid('request_id'),
    /** Null for denied requests (no valid key). */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    source: text('source', { enum: AUDIT_SOURCES }).notNull(),
    method: text('method').notNull(),
    upstreamId: uuid('upstream_id'),
    upstreamSlug: text('upstream_slug'),
    /** Upstream tool name; the public name when it could not be resolved; null for tools/list. */
    tool: text('tool'),
    durationMs: integer('duration_ms').notNull(),
    outcome: text('outcome', { enum: AUDIT_OUTCOMES }).notNull(),
    /** Short machine code (e.g. upstream_timeout, invalid_api_key), never free text from upstreams. */
    errorCode: text('error_code'),
  },
  (t) => [
    check('audit_source', sql`${t.source} in ('mcp', 'chat')`),
    check('audit_method', sql`${t.method} in ('tools/call', 'tools/list', 'initialize', 'other')`),
    check('audit_outcome', sql`${t.outcome} in ('ok', 'tool_error', 'error', 'timeout', 'unreachable', 'rejected', 'denied')`),
    check('audit_duration', sql`${t.durationMs} >= 0`),
    check('audit_error_code', sql`${t.errorCode} is null or ${t.errorCode} ~ '^[a-z_]{1,40}$'`),
    check('audit_denied_user', sql`${t.outcome} <> 'denied' or ${t.userId} is null`),
    index('audit_ts_idx').on(t.ts.desc()),
    index('audit_user_ts_idx').on(t.userId, t.ts.desc()),
    index('audit_upstream_ts_idx').on(t.upstreamSlug, t.ts.desc()),
  ],
);
export type AuditRow = typeof auditLog.$inferSelect;
