ALTER TABLE "trigger_cursors" ADD COLUMN "scope" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "trigger_events" ADD COLUMN "scope" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "trigger_cursors" DROP CONSTRAINT "trigger_cursors_pkey";
--> statement-breakpoint
ALTER TABLE "trigger_cursors" ADD CONSTRAINT "trigger_cursors_pkey" PRIMARY KEY("workspace_id","plugin_id","trigger","scope");--> statement-breakpoint
ALTER TABLE "trigger_events" DROP CONSTRAINT "trigger_events_pkey";
--> statement-breakpoint
ALTER TABLE "trigger_events" ADD CONSTRAINT "trigger_events_pkey" PRIMARY KEY("workspace_id","plugin_id","trigger","scope","event_id");