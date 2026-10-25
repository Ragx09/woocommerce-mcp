// Database schema (Drizzle). Migrations are generated from this file: `npm run db:generate -w services/gateway`.
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

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
    /** BON-13: set for a created store's woo-mcp (`woo-<slug>`); access then follows the store (owner, access list). */
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'set null' }),
    /** BON-10: set for a hosted MCP server (container image run by the provisioner); address and credentials belong to it. */
    hostedId: uuid('hosted_id').references(() => hostedServers.id, { onDelete: 'set null' }),
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

export const AUDIT_SOURCES = ['mcp', 'chat', 'oauth'] as const;
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
    check('audit_source', sql`${t.source} in ('mcp', 'chat', 'oauth')`),
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

// ---- Shared rate limits and leases (BON-04): the same budget on every gateway replica ----

/** One counter per bucket (`mcp:key:<id>`, `chat:user:<id>` …); the window starts at its first hit. */
export const rateLimits = pgTable(
  'rate_limits',
  {
    bucket: text('bucket').primaryKey(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    hits: integer('hits').notNull(),
  },
  (t) => [
    check('rate_limits_bucket', sql`char_length(${t.bucket}) between 1 and 200`),
    check('rate_limits_hits', sql`${t.hits} >= 0`),
  ],
);

/** Exclusive, self-expiring holds (e.g. "one chat request per user at a time" across replicas). */
export const leases = pgTable(
  'leases',
  {
    key: text('key').primaryKey(),
    holder: uuid('holder').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [check('leases_key', sql`char_length(${t.key}) between 1 and 200`)],
);

// ---- OAuth 2.1 for /mcp (BON-08, D-027): the gateway is its own authorization server ----
// Public clients only (PKCE S256, no client secrets). Codes, access and refresh tokens are random values of
// which only the SHA-256 is stored; a grant ties one user to one client and is what users and admins revoke.

/** Dynamically registered clients (RFC 7591). Redirect URIs are matched exactly. */
export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Public identifier handed to the client (`mcpc_` + random). Not a secret. */
    clientId: text('client_id').notNull().unique(),
    name: text('name').notNull(),
    redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('oauth_clients_client_id', sql`${t.clientId} ~ '^mcpc_[A-Za-z0-9_-]{22,64}$'`),
    check('oauth_clients_name_length', sql`char_length(${t.name}) between 1 and 100`),
    check('oauth_clients_redirects', sql`jsonb_typeof(${t.redirectUris}) = 'array' and jsonb_array_length(${t.redirectUris}) between 1 and 5`),
  ],
);
export type OAuthClient = typeof oauthClients.$inferSelect;

/** A pending /oauth/authorize request waiting for the user's consent in the dashboard (10 min). */
export const oauthRequests = pgTable(
  'oauth_requests',
  {
    idHash: text('id_hash').primaryKey(),
    clientId: uuid('client_id').notNull().references(() => oauthClients.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    state: text('state'),
    resource: text('resource').notNull(),
    scope: text('scope').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [check('oauth_requests_id_hash', sha256Hex(t.idHash)), check('oauth_requests_challenge', sql`${t.codeChallenge} ~ '^[A-Za-z0-9_-]{43}$'`)],
);

/** One user's consent to one client. Revoking it kills every code and token issued under it. */
export const oauthGrants = pgTable(
  'oauth_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id').notNull().references(() => oauthClients.id, { onDelete: 'cascade' }),
    resource: text('resource').notNull(),
    scope: text('scope').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    /** Why it ended: user/admin revoke, client revoke, or a replayed code/refresh token (RFC 9700 §4.14). */
    revokedReason: text('revoked_reason'),
  },
  (t) => [
    check('oauth_grants_reason', sql`${t.revokedReason} is null or ${t.revokedReason} in ('user', 'admin', 'client', 'replay')`),
    index('oauth_grants_user_idx').on(t.userId),
  ],
);

export const OAUTH_TOKEN_KINDS = ['code', 'access', 'refresh'] as const;
export type OAuthTokenKind = (typeof OAUTH_TOKEN_KINDS)[number];

/** Authorization codes, access tokens and refresh tokens, by hash. `usedAt` makes codes and refresh tokens single-use. */
export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    grantId: uuid('grant_id').notNull().references(() => oauthGrants.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: OAUTH_TOKEN_KINDS }).notNull(),
    /** Codes only: the PKCE challenge and redirect URI the token request must match. */
    codeChallenge: text('code_challenge'),
    redirectUri: text('redirect_uri'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => [
    check('oauth_tokens_hash', sha256Hex(t.tokenHash)),
    check('oauth_tokens_kind', sql`${t.kind} in ('code', 'access', 'refresh')`),
    check('oauth_tokens_code_fields', sql`(${t.kind} = 'code') = (${t.codeChallenge} is not null and ${t.redirectUri} is not null)`),
    index('oauth_tokens_grant_idx').on(t.grantId),
    index('oauth_tokens_expires_idx').on(t.expiresAt),
  ],
);

// ---- Multi-store (BON-09..15, D-026, SPEC A-11): desired state written by the gateway, reconciled by the provisioner ----

/** What the provisioner last saw in a store's or hosted server's namespace: counts and quota numbers only (BON-12, admin view). */
export interface RuntimeSnapshot {
  pods: { ready: number; total: number };
  /** `used` / `hard` for the namespace ResourceQuota: CPU in cores, memory in MiB. Absent without a quota. */
  quota?: { cpuLimits: { used: number; hard: number }; memoryLimitsMiB: { used: number; hard: number } };
}

export const STORE_NICHES = ['stationery', 'tea-coffee', 'home-ceramics', 'bags', 'bike', 'custom'] as const;
export type StoreNiche = (typeof STORE_NICHES)[number];
/** provisioning → ready | failed; deleting → deleted. Only the gateway writes (provisioner reports via the signed internal API). */
export const STORE_STATUSES = ['provisioning', 'ready', 'failed', 'deleting', 'deleted'] as const;
export type StoreStatus = (typeof STORE_STATUSES)[number];

/** One created store (namespace `store-<slug>`, Helm release `store-<slug>`, upstream `woo-<slug>`). */
export const stores = pgTable(
  'stores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 3–16 chars so `woo-<slug>` fits the upstream slug rule; derived from the name, immutable. */
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    tagline: text('tagline').notNull().default(''),
    niche: text('niche', { enum: STORE_NICHES }).notNull(),
    /** Custom niche only: the owner's niche text (the store's only category). */
    nicheText: text('niche_text'),
    ownerId: uuid('owner_id').notNull().references(() => users.id),
    /** Client idempotency key: the same create request twice → the same store. */
    requestKey: text('request_key').notNull(),
    status: text('status', { enum: STORE_STATUSES }).notNull().default('provisioning'),
    statusReason: text('status_reason'),
    /** What should exist: 'present' until deleted, then 'absent' (the provisioner tears it down). */
    desired: text('desired', { enum: ['present', 'absent'] }).notNull().default('present'),
    /** wp-admin password from the provisioner, encrypted (AAD store:<slug>); wiped after the one view. */
    adminPasswordEnc: jsonb('admin_password_enc').$type<EncryptedCredential>(),
    adminPasswordViewedAt: timestamp('admin_password_viewed_at', { withTimezone: true }),
    /** BON-12: an admin-requested wp-admin password reset. The new password is sealed with a key derived from the provisioner key. */
    passwordResetEnc: jsonb('password_reset_enc').$type<EncryptedCredential>(),
    passwordResetState: text('password_reset_state', { enum: ['pending', 'done', 'failed'] }),
    passwordResetReason: text('password_reset_reason'),
    passwordResetAt: timestamp('password_reset_at', { withTimezone: true }),
    /** BON-12: pods and quota as the provisioner last saw them (numbers only), for the admin view. */
    runtime: jsonb('runtime').$type<RuntimeSnapshot>(),
    runtimeAt: timestamp('runtime_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    check('stores_slug_format', sql`${t.slug} ~ '^[a-z][a-z0-9-]{1,14}[a-z0-9]$' and ${t.slug} !~ '--'`),
    check('stores_name_length', sql`char_length(${t.name}) between 1 and 60`),
    check('stores_tagline_length', sql`char_length(${t.tagline}) <= 120`),
    check('stores_niche', sql`${t.niche} in ('stationery', 'tea-coffee', 'home-ceramics', 'bags', 'bike', 'custom')`),
    check('stores_niche_text', sql`(${t.niche} = 'custom') = (${t.nicheText} is not null) and (${t.nicheText} is null or char_length(${t.nicheText}) between 1 and 60)`),
    check('stores_status', sql`${t.status} in ('provisioning', 'ready', 'failed', 'deleting', 'deleted')`),
    check('stores_desired', sql`${t.desired} in ('present', 'absent')`),
    check('stores_reason_length', sql`${t.statusReason} is null or char_length(${t.statusReason}) <= 300`),
    check('stores_password_reset_state', sql`${t.passwordResetState} is null or ${t.passwordResetState} in ('pending', 'done', 'failed')`),
    check('stores_password_reset_reason', sql`${t.passwordResetReason} is null or char_length(${t.passwordResetReason}) <= 300`),
    check('stores_request_key', sql`${t.requestKey} ~ '^[A-Za-z0-9_-]{8,64}$'`),
    uniqueIndex('stores_owner_request_idx').on(t.ownerId, t.requestKey),
    index('stores_owner_idx').on(t.ownerId),
  ],
);
export type Store = typeof stores.$inferSelect;

/** Members a store is shared with (A-11); they get the store upstream's member rule (default read-only). */
export const storeMembers = pgTable(
  'store_members',
  {
    storeId: uuid('store_id').notNull().references(() => stores.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.storeId, t.userId] }), index('store_members_user_idx').on(t.userId)],
);

// ---- Hosted MCP servers (BON-10, D-029): an admin adds a server by container image; the provisioner runs it ----

/** One hosted server (namespace `hosted-<slug>`, Helm release `hosted-<slug>`, upstream `<slug>`). */
export const hostedServers = pgTable(
  'hosted_servers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Becomes the upstream slug and the tool-name prefix (`<slug>__<tool>`); immutable. */
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    /** Registry/path:tag or @sha256 digest, from an allowed registry (config), never `latest`. */
    image: text('image').notNull(),
    port: integer('port').notNull(),
    path: text('path').notNull().default('/mcp'),
    /** Plain environment (visible to admins). */
    env: jsonb('env').$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    /** Secret environment, one AES-GCM blob of the JSON object, key derived from the gateway↔provisioner key. Write-only. */
    secretEnvEnc: jsonb('secret_env_enc').$type<EncryptedCredential>(),
    /** Names of the secret variables (never their values), so the UI can show what is set. */
    secretEnvNames: jsonb('secret_env_names').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Outbound HTTPS to the public internet (never the cluster). Default: none. */
    allowEgress: boolean('allow_egress').notNull().default(false),
    status: text('status', { enum: STORE_STATUSES }).notNull().default('provisioning'),
    statusReason: text('status_reason'),
    desired: text('desired', { enum: ['present', 'absent'] }).notNull().default('present'),
    runtime: jsonb('runtime').$type<RuntimeSnapshot>(),
    runtimeAt: timestamp('runtime_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    check('hosted_slug_format', sql`${t.slug} ~ '^[a-z][a-z0-9-]{1,14}[a-z0-9]$' and ${t.slug} !~ '--'`),
    check('hosted_name_length', sql`char_length(${t.name}) between 1 and 100`),
    check('hosted_image_format', sql`char_length(${t.image}) <= 255 and ${t.image} ~ '^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+|@sha256:[0-9a-f]{64})$'`),
    check('hosted_port', sql`${t.port} between 1 and 65535`),
    check('hosted_path', sql`${t.path} ~ '^/[A-Za-z0-9._~/-]{0,127}$'`),
    check('hosted_status', sql`${t.status} in ('provisioning', 'ready', 'failed', 'deleting', 'deleted')`),
    check('hosted_desired', sql`${t.desired} in ('present', 'absent')`),
    check('hosted_reason_length', sql`${t.statusReason} is null or char_length(${t.statusReason}) <= 300`),
    check('hosted_env_object', sql`jsonb_typeof(${t.env}) = 'object'`),
  ],
);
export type HostedServer = typeof hostedServers.$inferSelect;
