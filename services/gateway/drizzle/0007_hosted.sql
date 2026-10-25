CREATE TABLE "hosted_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"image" text NOT NULL,
	"port" integer NOT NULL,
	"path" text DEFAULT '/mcp' NOT NULL,
	"env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_env_enc" jsonb,
	"secret_env_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allow_egress" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"status_reason" text,
	"desired" text DEFAULT 'present' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosted_servers_slug_unique" UNIQUE("slug"),
	CONSTRAINT "hosted_slug_format" CHECK ("hosted_servers"."slug" ~ '^[a-z][a-z0-9-]{1,14}[a-z0-9]$' and "hosted_servers"."slug" !~ '--'),
	CONSTRAINT "hosted_name_length" CHECK (char_length("hosted_servers"."name") between 1 and 100),
	CONSTRAINT "hosted_image_format" CHECK (char_length("hosted_servers"."image") <= 255 and "hosted_servers"."image" ~ '^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+|@sha256:[0-9a-f]{64})$'),
	CONSTRAINT "hosted_port" CHECK ("hosted_servers"."port" between 1 and 65535),
	CONSTRAINT "hosted_path" CHECK ("hosted_servers"."path" ~ '^/[A-Za-z0-9._~/-]{0,127}$'),
	CONSTRAINT "hosted_status" CHECK ("hosted_servers"."status" in ('provisioning', 'ready', 'failed', 'deleting', 'deleted')),
	CONSTRAINT "hosted_desired" CHECK ("hosted_servers"."desired" in ('present', 'absent')),
	CONSTRAINT "hosted_reason_length" CHECK ("hosted_servers"."status_reason" is null or char_length("hosted_servers"."status_reason") <= 300),
	CONSTRAINT "hosted_env_object" CHECK (jsonb_typeof("hosted_servers"."env") = 'object')
);
--> statement-breakpoint
ALTER TABLE "upstreams" ADD COLUMN "hosted_id" uuid;--> statement-breakpoint
ALTER TABLE "hosted_servers" ADD CONSTRAINT "hosted_servers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstreams" ADD CONSTRAINT "upstreams_hosted_id_hosted_servers_id_fk" FOREIGN KEY ("hosted_id") REFERENCES "public"."hosted_servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- D-029: the provisioner reads what it must run (image, port, env, the encrypted secret env it can open with the
-- key derived from the shared signing key) and the desired state; it writes nothing (signed internal API).
GRANT SELECT (id, slug, name, image, port, path, env, secret_env_enc, allow_egress, status, desired, created_at, updated_at) ON hosted_servers TO provisioner;
