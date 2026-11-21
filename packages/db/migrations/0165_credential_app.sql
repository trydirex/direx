-- The OAuth app that issued each oauth2 grant, so a refresh or revoke uses that app rather than
-- whichever one a new connect would pick now. Nullable with no backfill: an older grant keeps
-- resolving as before until it is reconnected.
ALTER TABLE "credentials" ADD COLUMN "app_owner" text;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "app_client_id" text;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_app_check" CHECK (("credentials"."app_owner" is null) = ("credentials"."app_client_id" is null) and "credentials"."app_owner" in ('workspace', 'platform', 'deployment', 'sign_in'));