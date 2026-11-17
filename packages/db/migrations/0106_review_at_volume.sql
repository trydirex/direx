CREATE TABLE "review_decisions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "review_decisions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"decision" text NOT NULL,
	"campaign_id" uuid,
	"step_key" text,
	"opened_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"edit_distance" integer,
	"edit_phrases" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "review_decisions_step_check" CHECK (("review_decisions"."campaign_id" is null) = ("review_decisions"."step_key" is null)),
	CONSTRAINT "review_decisions_decision_check" CHECK ("review_decisions"."decision" in ('approve', 'edit_approve', 'reject')),
	CONSTRAINT "review_decisions_times_check" CHECK ("review_decisions"."opened_at" <= "review_decisions"."decided_at")
);
--> statement-breakpoint
ALTER TABLE "campaign_actions" ADD COLUMN "proposed_text" text;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD COLUMN "writer_notes" text;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD COLUMN "writer_notes_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_reviewer_id_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_item_fk" FOREIGN KEY ("workspace_id","item_id") REFERENCES "public"."items"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_decisions_reviewer_idx" ON "review_decisions" USING btree ("workspace_id","reviewer_id","decided_at");--> statement-breakpoint
CREATE INDEX "review_decisions_step_idx" ON "review_decisions" USING btree ("workspace_id","campaign_id","step_key");
--> statement-breakpoint
-- Forced RLS, same workspace policy as the rest. A decision is a record: written once, never changed.
ALTER TABLE review_decisions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE review_decisions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON review_decisions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE UPDATE, DELETE ON review_decisions FROM direx_app;
--> statement-breakpoint
-- The links stay fixed (0040 revoked UPDATE); only a rewrite's new proposal may replace the old one.
GRANT UPDATE (proposed_text) ON campaign_actions TO direx_app;
