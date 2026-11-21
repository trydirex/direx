CREATE TABLE "click_counts" (
	"workspace_id" uuid NOT NULL,
	"link_id" text NOT NULL,
	"day" date NOT NULL,
	"bucket" text NOT NULL,
	"classifier_version" integer NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "click_counts_pkey" PRIMARY KEY("workspace_id","link_id","day","bucket","classifier_version"),
	CONSTRAINT "click_counts_bucket_check" CHECK ("click_counts"."bucket" in ('automatic', 'rest')),
	CONSTRAINT "click_counts_count_check" CHECK ("click_counts"."count" > 0)
);
--> statement-breakpoint
CREATE TABLE "tracking_counters" (
	"workspace_id" uuid NOT NULL,
	"link_id" text NOT NULL,
	"minute" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "tracking_counters_pkey" PRIMARY KEY("workspace_id","link_id","minute"),
	CONSTRAINT "tracking_counters_count_check" CHECK ("tracking_counters"."count" > 0)
);
--> statement-breakpoint
ALTER TABLE "click_counts" ADD CONSTRAINT "click_counts_link_fk" FOREIGN KEY ("workspace_id","link_id") REFERENCES "public"."tracked_links"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking_counters" ADD CONSTRAINT "tracking_counters_link_fk" FOREIGN KEY ("workspace_id","link_id") REFERENCES "public"."tracked_links"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Forced RLS, same workspace policy as every Workspace table.
ALTER TABLE click_counts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE click_counts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON click_counts
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE tracking_counters ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tracking_counters FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON tracking_counters
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- Daily counts only grow, and go with the Workspace (ADR 0035 rule 017).
REVOKE DELETE ON click_counts FROM direx_app;
--> statement-breakpoint
CREATE FUNCTION public.click_counts_keep_growth()
RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'click_counts: count cannot decrease and the key cannot change' USING ERRCODE = 'check_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER click_counts_keep_growth
  BEFORE UPDATE ON public.click_counts
  FOR EACH ROW WHEN (
    NEW.count < OLD.count OR
    (NEW.workspace_id, NEW.link_id, NEW.day, NEW.bucket, NEW.classifier_version)
      IS DISTINCT FROM (OLD.workspace_id, OLD.link_id, OLD.day, OLD.bucket, OLD.classifier_version)
  )
  EXECUTE FUNCTION public.click_counts_keep_growth();
