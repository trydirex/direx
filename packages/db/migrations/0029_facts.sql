CREATE TABLE "fact_versions" (
	"workspace_id" uuid NOT NULL,
	"fact_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"value" text NOT NULL,
	"source" jsonb NOT NULL,
	"confidence" text NOT NULL,
	"digest" text NOT NULL,
	"actor_user_id" uuid,
	"actor_agent_run_id" uuid,
	"actor_system" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "fact_versions_pkey" PRIMARY KEY("workspace_id","fact_id","version"),
	CONSTRAINT "fact_versions_confidence_check" CHECK ("fact_versions"."confidence" in ('low', 'medium', 'high')),
	CONSTRAINT "fact_versions_one_actor_check" CHECK (num_nonnulls("fact_versions"."actor_user_id", "fact_versions"."actor_agent_run_id", "fact_versions"."actor_system") = 1)
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"field" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"current_version" integer NOT NULL,
	"retired_at" timestamp with time zone,
	"retired_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "facts_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "facts_field_check" CHECK ("facts"."field" in ('what_you_sell', 'who_buys', 'tone', 'price', 'claim', 'never_say'))
);
--> statement-breakpoint
ALTER TABLE "fact_versions" ADD CONSTRAINT "fact_versions_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_versions" ADD CONSTRAINT "fact_versions_fact_fk" FOREIGN KEY ("workspace_id","fact_id") REFERENCES "public"."facts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_retired_by_user_id_fk" FOREIGN KEY ("retired_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "facts_one_live_per_slot" ON "facts" USING btree ("workspace_id","field","subject") WHERE "facts"."retired_at" is null;