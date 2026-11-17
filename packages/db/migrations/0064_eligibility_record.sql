ALTER TABLE "outreach_settings" ADD COLUMN "sender_country" text;--> statement-breakpoint
ALTER TABLE "person_eligibility" ADD COLUMN "entity_type" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "person_eligibility" ADD COLUMN "scope" text;--> statement-breakpoint
ALTER TABLE "person_eligibility" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "person_eligibility" ADD COLUMN "country_confidence" text DEFAULT 'stated' NOT NULL;--> statement-breakpoint
ALTER TABLE "outreach_settings" ADD CONSTRAINT "outreach_settings_sender_country_check" CHECK ("outreach_settings"."sender_country" ~ '^[A-Z]{2}$');--> statement-breakpoint
ALTER TABLE "person_eligibility" ADD CONSTRAINT "person_eligibility_entity_type_check" CHECK ("person_eligibility"."entity_type" in ('corporate', 'sole_trader', 'partnership', 'unknown'));--> statement-breakpoint
ALTER TABLE "person_eligibility" ADD CONSTRAINT "person_eligibility_scope_check" CHECK (length("person_eligibility"."scope") <= 500);--> statement-breakpoint
ALTER TABLE "person_eligibility" ADD CONSTRAINT "person_eligibility_country_confidence_check" CHECK ("person_eligibility"."country_confidence" in ('stated', 'inferred'));