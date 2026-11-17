CREATE TABLE "placement_list_state" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"list" jsonb NOT NULL,
	"root_chain_length" integer NOT NULL,
	"root_chain_hash" text NOT NULL,
	"trusted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "placement_list_state_version_check" CHECK ("placement_list_state"."version" >= 1),
	CONSTRAINT "placement_list_state_root_chain_length_check" CHECK ("placement_list_state"."root_chain_length" >= 0)
);
--> statement-breakpoint
ALTER TABLE "placement_list_state" ADD CONSTRAINT "placement_list_state_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Forced RLS, same workspace policy as every Workspace table.
ALTER TABLE placement_list_state ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE placement_list_state FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON placement_list_state
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- The trusted list only moves forward; removing it would let an older list back in.
REVOKE DELETE ON placement_list_state FROM direx_app;
