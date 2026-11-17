ALTER TABLE "credentials" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "paused_by" uuid;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "resumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_paused_by_user_id_fk" FOREIGN KEY ("paused_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_pause_check" CHECK (("credentials"."paused_at" is null) = ("credentials"."pause_reason" is null) and "credentials"."pause_reason" in ('bounces', 'person'));