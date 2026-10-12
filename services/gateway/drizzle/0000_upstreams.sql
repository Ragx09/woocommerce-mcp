CREATE TABLE "upstreams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"auth_type" text DEFAULT 'none' NOT NULL,
	"auth_header" text,
	"credential_enc" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upstreams_slug_unique" UNIQUE("slug"),
	CONSTRAINT "upstreams_slug_format" CHECK ("upstreams"."slug" ~ '^[a-z0-9-]{1,20}$'),
	CONSTRAINT "upstreams_name_length" CHECK (char_length("upstreams"."name") between 1 and 100),
	CONSTRAINT "upstreams_url_http" CHECK ("upstreams"."url" ~ '^https?://' and char_length("upstreams"."url") <= 2048),
	CONSTRAINT "upstreams_auth_type" CHECK ("upstreams"."auth_type" in ('none', 'header', 'bearer')),
	CONSTRAINT "upstreams_auth_header" CHECK (("upstreams"."auth_type" = 'header') = ("upstreams"."auth_header" is not null)
          and ("upstreams"."auth_header" is null or "upstreams"."auth_header" ~ '^[A-Za-z0-9-]{1,64}$')),
	CONSTRAINT "upstreams_credential" CHECK ("upstreams"."auth_type" <> 'none' or "upstreams"."credential_enc" is null)
);
