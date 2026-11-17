CREATE TABLE "ask_starts" (
	"workspace_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"work_kind" text,
	"work_id" text,
	"refused" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ask_starts_pkey" PRIMARY KEY("workspace_id","item_id"),
	CONSTRAINT "ask_starts_work_check" CHECK (("ask_starts"."work_kind" is null) = ("ask_starts"."work_id" is null)),
	CONSTRAINT "ask_starts_outcome_check" CHECK ("ask_starts"."work_kind" is null or "ask_starts"."refused" is null)
);
--> statement-breakpoint
ALTER TABLE "ask_starts" ADD CONSTRAINT "ask_starts_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ask_starts" ADD CONSTRAINT "ask_starts_item_fk" FOREIGN KEY ("workspace_id","item_id") REFERENCES "public"."items"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ask_starts" ADD CONSTRAINT "ask_starts_message_fk" FOREIGN KEY ("workspace_id","message_id") REFERENCES "public"."ask_messages"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ask_starts_message" ON "ask_starts" USING btree ("workspace_id","message_id");--> statement-breakpoint
-- Forced RLS, same workspace policy as the rest. A start is kept; only its outcome is written later.
ALTER TABLE ask_starts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ask_starts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON ask_starts
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE DELETE ON ask_starts FROM direx_app;
