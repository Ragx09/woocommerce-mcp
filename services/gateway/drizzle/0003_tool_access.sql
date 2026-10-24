ALTER TABLE "upstreams" ADD COLUMN "member_access" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "upstreams" ADD COLUMN "member_tools" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "upstreams" ADD CONSTRAINT "upstreams_member_access" CHECK ("upstreams"."member_access" in ('all', 'none', 'selected'));--> statement-breakpoint
ALTER TABLE "upstreams" ADD CONSTRAINT "upstreams_member_tools" CHECK (jsonb_typeof("upstreams"."member_tools") = 'array' and jsonb_array_length("upstreams"."member_tools") <= 200);