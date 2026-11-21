-- A new Mailbox's ramp: it starts at 20 emails a day and grows after clean sending days. The
-- columns are added empty and get their defaults after, so every Mailbox connected before the ramp
-- stays established, with no ramp, and nobody's sending drops on upgrade. Each one connected from
-- now on starts on the ramp.
ALTER TABLE "credentials" ADD COLUMN "ramp_limit" integer;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "ramp_clean_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credentials" ALTER COLUMN "ramp_limit" SET DEFAULT 20;--> statement-breakpoint
ALTER TABLE "credentials" ALTER COLUMN "ramp_clean_since" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_ramp_check" CHECK (("credentials"."ramp_limit" is null) = ("credentials"."ramp_clean_since" is null) and ("credentials"."ramp_limit" is null or "credentials"."ramp_limit" between 1 and 500));
