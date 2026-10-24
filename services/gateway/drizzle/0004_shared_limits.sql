CREATE TABLE "leases" (
	"key" text PRIMARY KEY NOT NULL,
	"holder" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "leases_key" CHECK (char_length("leases"."key") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"bucket" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"hits" integer NOT NULL,
	CONSTRAINT "rate_limits_bucket" CHECK (char_length("rate_limits"."bucket") between 1 and 200),
	CONSTRAINT "rate_limits_hits" CHECK ("rate_limits"."hits" >= 0)
);
