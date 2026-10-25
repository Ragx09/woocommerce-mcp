ALTER TABLE "hosted_servers" ADD COLUMN "runtime" jsonb;--> statement-breakpoint
ALTER TABLE "hosted_servers" ADD COLUMN "runtime_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "password_reset_enc" jsonb;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "password_reset_state" text;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "password_reset_reason" text;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "password_reset_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "runtime" jsonb;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "runtime_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_password_reset_state" CHECK ("stores"."password_reset_state" is null or "stores"."password_reset_state" in ('pending', 'done', 'failed'));--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_password_reset_reason" CHECK ("stores"."password_reset_reason" is null or char_length("stores"."password_reset_reason") <= 300);--> statement-breakpoint
-- BON-12: the provisioner reads a pending password reset (sealed with a key it can derive) to carry it out; it still writes nothing.
GRANT SELECT (password_reset_enc, password_reset_state, password_reset_at) ON stores TO provisioner;
