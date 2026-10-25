CREATE TABLE "oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_clients_client_id_unique" UNIQUE("client_id"),
	CONSTRAINT "oauth_clients_client_id" CHECK ("oauth_clients"."client_id" ~ '^mcpc_[A-Za-z0-9_-]{22,64}$'),
	CONSTRAINT "oauth_clients_name_length" CHECK (char_length("oauth_clients"."name") between 1 and 100),
	CONSTRAINT "oauth_clients_redirects" CHECK (jsonb_typeof("oauth_clients"."redirect_uris") = 'array' and jsonb_array_length("oauth_clients"."redirect_uris") between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "oauth_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"scope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoked_reason" text,
	CONSTRAINT "oauth_grants_reason" CHECK ("oauth_grants"."revoked_reason" is null or "oauth_grants"."revoked_reason" in ('user', 'admin', 'client', 'replay'))
);
--> statement-breakpoint
CREATE TABLE "oauth_requests" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"state" text,
	"resource" text NOT NULL,
	"scope" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "oauth_requests_id_hash" CHECK ("oauth_requests"."id_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "oauth_requests_challenge" CHECK ("oauth_requests"."code_challenge" ~ '^[A-Za-z0-9_-]{43}$')
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"grant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"code_challenge" text,
	"redirect_uri" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "oauth_tokens_hash" CHECK ("oauth_tokens"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "oauth_tokens_kind" CHECK ("oauth_tokens"."kind" in ('code', 'access', 'refresh')),
	CONSTRAINT "oauth_tokens_code_fields" CHECK (("oauth_tokens"."kind" = 'code') = ("oauth_tokens"."code_challenge" is not null and "oauth_tokens"."redirect_uri" is not null))
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_source";--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_requests" ADD CONSTRAINT "oauth_requests_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_grants_user_idx" ON "oauth_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_tokens_grant_idx" ON "oauth_tokens" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "oauth_tokens_expires_idx" ON "oauth_tokens" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_source" CHECK ("audit_log"."source" in ('mcp', 'chat', 'oauth'));