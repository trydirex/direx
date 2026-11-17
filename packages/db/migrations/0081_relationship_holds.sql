CREATE TABLE "correspondents" (
	"workspace_id" uuid NOT NULL,
	"email_hash" text NOT NULL,
	"source" text NOT NULL,
	"credential_id" uuid NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "correspondents_pkey" PRIMARY KEY("workspace_id","email_hash","source"),
	CONSTRAINT "correspondents_source_check" CHECK ("correspondents"."source" in ('sent_mail'))
);
--> statement-breakpoint
CREATE TABLE "hold_hooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" uuid NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "hold_hooks_workspace_id_id_key" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "hold_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"released_at" timestamp with time zone NOT NULL,
	"released_by" uuid NOT NULL,
	CONSTRAINT "hold_releases_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "hold_releases_kind_check" CHECK ("hold_releases"."kind" in ('inferred', 'company'))
);
--> statement-breakpoint
CREATE TABLE "relationship_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email_hash" text NOT NULL,
	"domain" text,
	"person_id" uuid,
	"source" text NOT NULL,
	"source_ref" text,
	"reason" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	"created_by" uuid,
	CONSTRAINT "relationship_holds_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "relationship_holds_source_ref_key" UNIQUE("workspace_id","source","source_ref","email_hash"),
	CONSTRAINT "relationship_holds_source_check" CHECK ("relationship_holds"."source" in ('manual', 'webhook')),
	CONSTRAINT "relationship_holds_source_ref_check" CHECK (("relationship_holds"."source" = 'manual') = ("relationship_holds"."source_ref" is null)),
	CONSTRAINT "relationship_holds_term_check" CHECK ("relationship_holds"."expires_at" > "relationship_holds"."started_at")
);
--> statement-breakpoint
ALTER TABLE "correspondents" ADD CONSTRAINT "correspondents_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondents" ADD CONSTRAINT "correspondents_credential_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."credentials"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hold_hooks" ADD CONSTRAINT "hold_hooks_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hold_hooks" ADD CONSTRAINT "hold_hooks_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hold_hooks" ADD CONSTRAINT "hold_hooks_credential_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."credentials"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hold_releases" ADD CONSTRAINT "hold_releases_released_by_user_id_fk" FOREIGN KEY ("released_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hold_releases" ADD CONSTRAINT "hold_releases_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hold_releases" ADD CONSTRAINT "hold_releases_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_holds" ADD CONSTRAINT "relationship_holds_ended_by_user_id_fk" FOREIGN KEY ("ended_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_holds" ADD CONSTRAINT "relationship_holds_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_holds" ADD CONSTRAINT "relationship_holds_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_holds" ADD CONSTRAINT "relationship_holds_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hold_releases_person_idx" ON "hold_releases" USING btree ("workspace_id","person_id","kind","released_at");--> statement-breakpoint
CREATE INDEX "relationship_holds_email_idx" ON "relationship_holds" USING btree ("workspace_id","email_hash");--> statement-breakpoint
CREATE INDEX "relationship_holds_domain_idx" ON "relationship_holds" USING btree ("workspace_id","domain");