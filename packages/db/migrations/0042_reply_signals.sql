CREATE TABLE "reply_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"credential_id" uuid,
	"event_id" text NOT NULL,
	"sender_email" text NOT NULL,
	"person_id" uuid,
	"action_id" uuid,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"decided_by" text,
	"quote" text,
	"bounce_status" text,
	"text" text,
	"received_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "reply_signals_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "reply_signals_event_key" UNIQUE NULLS NOT DISTINCT("workspace_id","credential_id","event_id"),
	CONSTRAINT "reply_signals_kind_check" CHECK ("reply_signals"."kind" in ('reply', 'bounce')),
	CONSTRAINT "reply_signals_status_check" CHECK ("reply_signals"."status" in ('pending', 'opted_out', 'not_opt_out', 'needs_person', 'recorded')),
	CONSTRAINT "reply_signals_decided_by_check" CHECK ("reply_signals"."decided_by" in ('rule', 'model', 'person'))
);
--> statement-breakpoint
ALTER TABLE "suppressions" DROP CONSTRAINT "suppressions_reason_check";--> statement-breakpoint
ALTER TABLE "reply_signals" ADD CONSTRAINT "reply_signals_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_signals" ADD CONSTRAINT "reply_signals_credential_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."credentials"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_signals" ADD CONSTRAINT "reply_signals_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_signals" ADD CONSTRAINT "reply_signals_action_fk" FOREIGN KEY ("workspace_id","action_id") REFERENCES "public"."actions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reply_signals_open_idx" ON "reply_signals" USING btree ("workspace_id","status");--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_reason_check" CHECK ("suppressions"."reason" in ('unsubscribe', 'manual', 'reply', 'hard_bounce'));