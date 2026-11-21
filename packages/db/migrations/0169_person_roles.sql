-- Person roles: what a Person is to the Workspace, starting with its own customers. The role's
-- name and company are what the customer import gave. A role is never edited, only its name and
-- company; removing one deletes its row, so DELETE stays granted.
CREATE TABLE "person_roles" (
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"role" text NOT NULL,
	"name" text,
	"company" text,
	"added_by" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "person_roles_pkey" PRIMARY KEY("workspace_id","person_id","role"),
	CONSTRAINT "person_roles_role_check" CHECK ("person_roles"."role" in ('customer')),
	CONSTRAINT "person_roles_name_check" CHECK (length("person_roles"."name") <= 200),
	CONSTRAINT "person_roles_company_check" CHECK (length("person_roles"."company") <= 200)
);
--> statement-breakpoint
ALTER TABLE "person_roles" ADD CONSTRAINT "person_roles_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_roles" ADD CONSTRAINT "person_roles_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "person_roles_workspace_id_role_idx" ON "person_roles" USING btree ("workspace_id","role");--> statement-breakpoint
ALTER TABLE person_roles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE person_roles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON person_roles
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE UPDATE ON person_roles FROM direx_app;
--> statement-breakpoint
GRANT UPDATE (name, company) ON person_roles TO direx_app;
