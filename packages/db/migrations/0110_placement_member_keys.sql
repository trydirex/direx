CREATE TABLE "placement_member_keys" (
	"workspace_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"key_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "placement_member_keys_pkey" PRIMARY KEY("workspace_id","credential_id")
);
--> statement-breakpoint
ALTER TABLE "placement_member_keys" ADD CONSTRAINT "placement_member_keys_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_member_keys" ADD CONSTRAINT "placement_member_keys_credential_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."credentials"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Forced RLS, same workspace policy as every Workspace table.
ALTER TABLE placement_member_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE placement_member_keys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON placement_member_keys
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- A member key is made once and never changed or removed: its public half is in the member list.
REVOKE UPDATE, DELETE ON placement_member_keys FROM direx_app;
