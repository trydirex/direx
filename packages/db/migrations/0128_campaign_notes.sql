ALTER TABLE "campaigns" ADD COLUMN "notes" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "notes_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "notes_updated_by" uuid;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "notes_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_notes_updated_by_user_id_fk" FOREIGN KEY ("notes_updated_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_notes_length_check" CHECK (char_length("campaigns"."notes") <= 10000);--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_notes_updated_check" CHECK (("campaigns"."notes_updated_by" is null) = ("campaigns"."notes_updated_at" is null));