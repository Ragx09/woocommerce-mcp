CREATE TABLE "store_members" (
	"store_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_members_store_id_user_id_pk" PRIMARY KEY("store_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"tagline" text DEFAULT '' NOT NULL,
	"niche" text NOT NULL,
	"niche_text" text,
	"owner_id" uuid NOT NULL,
	"request_key" text NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"status_reason" text,
	"desired" text DEFAULT 'present' NOT NULL,
	"admin_password_enc" jsonb,
	"admin_password_viewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stores_slug_unique" UNIQUE("slug"),
	CONSTRAINT "stores_slug_format" CHECK ("stores"."slug" ~ '^[a-z][a-z0-9-]{1,14}[a-z0-9]$' and "stores"."slug" !~ '--'),
	CONSTRAINT "stores_name_length" CHECK (char_length("stores"."name") between 1 and 60),
	CONSTRAINT "stores_tagline_length" CHECK (char_length("stores"."tagline") <= 120),
	CONSTRAINT "stores_niche" CHECK ("stores"."niche" in ('stationery', 'tea-coffee', 'home-ceramics', 'bags', 'bike', 'custom')),
	CONSTRAINT "stores_niche_text" CHECK (("stores"."niche" = 'custom') = ("stores"."niche_text" is not null) and ("stores"."niche_text" is null or char_length("stores"."niche_text") between 1 and 60)),
	CONSTRAINT "stores_status" CHECK ("stores"."status" in ('provisioning', 'ready', 'failed', 'deleting', 'deleted')),
	CONSTRAINT "stores_desired" CHECK ("stores"."desired" in ('present', 'absent')),
	CONSTRAINT "stores_reason_length" CHECK ("stores"."status_reason" is null or char_length("stores"."status_reason") <= 300),
	CONSTRAINT "stores_request_key" CHECK ("stores"."request_key" ~ '^[A-Za-z0-9_-]{8,64}$')
);
--> statement-breakpoint
ALTER TABLE "upstreams" ADD COLUMN "store_id" uuid;--> statement-breakpoint
ALTER TABLE "store_members" ADD CONSTRAINT "store_members_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_members" ADD CONSTRAINT "store_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_members" ADD CONSTRAINT "store_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "store_members_user_idx" ON "store_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_owner_request_idx" ON "stores" USING btree ("owner_id","request_key");--> statement-breakpoint
CREATE INDEX "stores_owner_idx" ON "stores" USING btree ("owner_id");--> statement-breakpoint
ALTER TABLE "upstreams" ADD CONSTRAINT "upstreams_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- D-026: the provisioner reads desired state with its own login role and may only SELECT what it needs from
-- `stores` (no passwords, no other table); every write goes through the gateway's signed internal API.
-- NOLOGIN here; the gateway sets LOGIN + password at startup from the provisioner-db Secret.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'provisioner') THEN CREATE ROLE provisioner NOLOGIN; END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO provisioner;--> statement-breakpoint
GRANT SELECT (id, slug, name, tagline, niche, niche_text, status, desired, created_at, updated_at) ON stores TO provisioner;
