-- A provider refusing a Mailbox's email as abuse pauses the Mailbox, as too many bounces do. Only
-- a person's resume clears it.
ALTER TABLE "credentials" DROP CONSTRAINT "credentials_pause_check";--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_pause_check" CHECK (("credentials"."paused_at" is null) = ("credentials"."pause_reason" is null) and "credentials"."pause_reason" in ('bounces', 'provider_abuse', 'person'));
