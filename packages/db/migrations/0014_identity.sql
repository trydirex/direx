CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_audit" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "workspace_audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"event" text NOT NULL,
	"subject_user_id" uuid,
	"subject_email" text,
	"from_role" text,
	"to_role" text,
	"step_up" boolean DEFAULT false NOT NULL,
	"actor_user_id" uuid,
	"actor_system" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "workspace_audit_one_actor_check" CHECK (num_nonnulls("workspace_audit"."actor_user_id", "workspace_audit"."actor_system") = 1)
);
--> statement-breakpoint
CREATE TABLE "workspace_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workspace_invites_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "workspace_invites_role_check" CHECK ("workspace_invites"."role" in ('owner', 'admin', 'marketer', 'contributor', 'viewer')),
	CONSTRAINT "workspace_invites_email_lower_check" CHECK ("workspace_invites"."email" = lower("workspace_invites"."email"))
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workspace_members_pkey" PRIMARY KEY("workspace_id","user_id"),
	CONSTRAINT "workspace_members_role_check" CHECK ("workspace_members"."role" in ('owner', 'admin', 'marketer', 'contributor', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid GENERATED ALWAYS AS (id) STORED NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "workspaces_workspace_id_key" UNIQUE("workspace_id")
);
--> statement-breakpoint
ALTER TABLE "workspace_audit" ADD CONSTRAINT "workspace_audit_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_audit_workspace_id_at_idx" ON "workspace_audit" USING btree ("workspace_id","at");--> statement-breakpoint
CREATE INDEX "workspace_invites_workspace_id_idx" ON "workspace_invites" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_members_user_id_idx" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "workspaces_org_id_idx" ON "workspaces" USING btree ("org_id");