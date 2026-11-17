ALTER TABLE "campaigns" ADD COLUMN "advance" text DEFAULT 'offer' NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "advance_set_by" uuid;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "advance_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "advance_time_zone" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_advance_set_by_user_id_fk" FOREIGN KEY ("advance_set_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_advance_check" CHECK ("campaigns"."advance" = 'offer' or ("campaigns"."advance" = 'run' and "campaigns"."advance_set_by" is not null and "campaigns"."advance_time_zone" is not null));