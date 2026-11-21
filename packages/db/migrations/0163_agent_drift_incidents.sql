CREATE TABLE "agent_drift_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"definition_version" integer NOT NULL,
	"route_hash" text NOT NULL,
	"measure" text NOT NULL,
	"previous_definition_version" integer NOT NULL,
	"previous_route_hash" text,
	"rate" real NOT NULL,
	"previous_rate" real NOT NULL,
	"runs" integer NOT NULL,
	"previous_runs" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_drift_incidents_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "agent_drift_incidents_version_measure_key" UNIQUE("workspace_id","agent","definition_version","route_hash","measure"),
	CONSTRAINT "agent_drift_incidents_measure_check" CHECK ("agent_drift_incidents"."measure" in ('rejections', 'citations'))
);
--> statement-breakpoint
ALTER TABLE "agent_drift_incidents" ADD CONSTRAINT "agent_drift_incidents_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Forced RLS, same workspace policy as every Workspace table.
ALTER TABLE agent_drift_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_drift_incidents FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON agent_drift_incidents
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- An incident is a record of what was sent, kept as made; only the Workspace purge removes it.
REVOKE UPDATE, DELETE ON agent_drift_incidents FROM direx_app;
