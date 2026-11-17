CREATE TABLE "suppression_reversals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"suppressed_at" timestamp with time zone NOT NULL,
	"undone_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"quote" text,
	"undone_at" timestamp with time zone NOT NULL,
	CONSTRAINT "suppression_reversals_reason_check" CHECK (length(btrim("suppression_reversals"."reason")) between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "suppression_reversals" ADD CONSTRAINT "suppression_reversals_undone_by_user_id_fk" FOREIGN KEY ("undone_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppression_reversals" ADD CONSTRAINT "suppression_reversals_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "suppression_reversals_email_idx" ON "suppression_reversals" USING btree ("workspace_id","email");--> statement-breakpoint
-- Forced RLS, same workspace policy as the rest. The app reads the record; only the function below writes it.
ALTER TABLE suppression_reversals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE suppression_reversals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON suppression_reversals
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON suppression_reversals FROM direx_app;
--> statement-breakpoint
-- The one way a suppression is removed: an Owner's undo of an opt-out read from a reply, in the caller's
-- Workspace. Unsubscribe clicks, manual entries and hard bounces are never touched. Each removed row is
-- copied to suppression_reversals in the same statement, so a refused record keeps the suppression.
CREATE FUNCTION system.undo_reply_suppressions(emails text[], undone_by uuid, reason text, quote text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  ws uuid := nullif(current_setting('app.workspace_id', true), '')::uuid;
  moved integer;
BEGIN
  IF ws IS NULL THEN
    RAISE EXCEPTION 'undo_reply_suppressions needs app.workspace_id';
  END IF;
  WITH gone AS (
    DELETE FROM public.suppressions s
      WHERE s.workspace_id = ws AND s.reason = 'reply' AND s.email = ANY (emails)
      RETURNING s.email, s.created_at
  )
  INSERT INTO public.suppression_reversals (workspace_id, email, suppressed_at, undone_by, reason, quote, undone_at)
    SELECT ws, g.email, g.created_at, undo_reply_suppressions.undone_by, undo_reply_suppressions.reason, undo_reply_suppressions.quote, now()
    FROM gone g;
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved > 0 THEN
    INSERT INTO system.system_audit (function_name, rows_returned) VALUES ('undo_reply_suppressions', moved);
  END IF;
  RETURN moved;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system.undo_reply_suppressions(text[], uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system.undo_reply_suppressions(text[], uuid, text, text) TO direx_app;
