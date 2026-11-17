CREATE TABLE "trigger_cursors" (
	"workspace_id" uuid NOT NULL,
	"plugin_id" text NOT NULL,
	"trigger" text NOT NULL,
	"cursor" text NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trigger_cursors_pkey" PRIMARY KEY("workspace_id","plugin_id","trigger")
);
--> statement-breakpoint
CREATE TABLE "trigger_events" (
	"workspace_id" uuid NOT NULL,
	"plugin_id" text NOT NULL,
	"trigger" text NOT NULL,
	"event_id" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trigger_events_pkey" PRIMARY KEY("workspace_id","plugin_id","trigger","event_id")
);
