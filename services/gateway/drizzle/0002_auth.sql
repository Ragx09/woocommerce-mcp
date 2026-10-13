CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash"),
	CONSTRAINT "api_keys_key_hash" CHECK ("api_keys"."key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "api_keys_prefix" CHECK ("api_keys"."prefix" ~ '^mgw_[A-Za-z0-9]{8}$'),
	CONSTRAINT "api_keys_name_length" CHECK (char_length("api_keys"."name") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" uuid,
	"user_id" uuid,
	"api_key_id" uuid,
	"source" text NOT NULL,
	"method" text NOT NULL,
	"upstream_id" uuid,
	"upstream_slug" text,
	"tool" text,
	"duration_ms" integer NOT NULL,
	"outcome" text NOT NULL,
	"error_code" text,
	CONSTRAINT "audit_source" CHECK ("audit_log"."source" in ('mcp', 'chat')),
	CONSTRAINT "audit_method" CHECK ("audit_log"."method" in ('tools/call', 'tools/list', 'initialize', 'other')),
	CONSTRAINT "audit_outcome" CHECK ("audit_log"."outcome" in ('ok', 'tool_error', 'error', 'timeout', 'unreachable', 'rejected', 'denied')),
	CONSTRAINT "audit_duration" CHECK ("audit_log"."duration_ms" >= 0),
	CONSTRAINT "audit_error_code" CHECK ("audit_log"."error_code" is null or "audit_log"."error_code" ~ '^[a-z_]{1,40}$'),
	CONSTRAINT "audit_denied_user" CHECK ("audit_log"."outcome" <> 'denied' or "audit_log"."user_id" is null)
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by" uuid,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invites_token_hash" CHECK ("invites"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "invites_email_format" CHECK ("invites"."email" = lower("invites"."email") and "invites"."email" ~ '^[^@[:space:]]+@[^@[:space:]]+$' and char_length("invites"."email") <= 254),
	CONSTRAINT "invites_role" CHECK ("invites"."role" in ('admin', 'member')),
	CONSTRAINT "invites_expiry" CHECK ("invites"."expires_at" > "invites"."created_at"),
	CONSTRAINT "invites_used" CHECK ("invites"."used_by" is null or "invites"."used_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_id_hash" CHECK ("sessions"."id_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sessions_expiry" CHECK ("sessions"."expires_at" > "sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"password_hash" text NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_email_format" CHECK ("users"."email" = lower("users"."email") and "users"."email" ~ '^[^@[:space:]]+@[^@[:space:]]+$' and char_length("users"."email") <= 254),
	CONSTRAINT "users_name_length" CHECK (char_length("users"."name") between 1 and 100),
	CONSTRAINT "users_role" CHECK ("users"."role" in ('admin', 'member')),
	CONSTRAINT "users_password_hash" CHECK ("users"."password_hash" like '$argon2id$%')
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_used_by_users_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_user_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_ts_idx" ON "audit_log" USING btree ("ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_user_ts_idx" ON "audit_log" USING btree ("user_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_upstream_ts_idx" ON "audit_log" USING btree ("upstream_slug","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "upstreams" ADD CONSTRAINT "upstreams_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;