CREATE TABLE "budget_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reserved_micros" bigint NOT NULL,
	"settled_micros" bigint,
	"status" text DEFAULT 'held' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "budget_reservations_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "budget_reservations_kind_check" CHECK ("budget_reservations"."kind" in ('model')),
	CONSTRAINT "budget_reservations_status_check" CHECK ("budget_reservations"."status" in ('held', 'settled', 'released')),
	CONSTRAINT "budget_reservations_settled_check" CHECK (("budget_reservations"."status" = 'settled') = ("budget_reservations"."settled_micros" is not null))
);
--> statement-breakpoint
CREATE TABLE "model_budget_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"month" text NOT NULL,
	"threshold" integer NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	CONSTRAINT "model_budget_incidents_workspace_month_threshold_key" UNIQUE("workspace_id","month","threshold"),
	CONSTRAINT "model_budget_incidents_threshold_check" CHECK ("model_budget_incidents"."threshold" in (80, 100))
);
--> statement-breakpoint
CREATE TABLE "model_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"actor_user_id" uuid,
	"run_id" uuid,
	"purpose" text NOT NULL,
	"route_hash" text,
	"provider" text,
	"requested_model" text,
	"resolved_model" text,
	"credential_kind" text,
	"trust" text NOT NULL,
	"untrusted_sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tools_offered" text[] DEFAULT '{}' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"refusal" text,
	"error_family" text,
	"provider_request_id" text,
	"input_tokens" integer,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"output_tokens" integer,
	"reasoning_tokens" integer,
	"reservation_id" uuid,
	"cost_micros" bigint,
	"cost_status" text,
	"pricing_provenance" text,
	"over_reserved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "model_calls_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "model_calls_workspace_id_idempotency_key_key" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "model_calls_status_check" CHECK ("model_calls"."status" in ('dispatched', 'completed', 'failed', 'refused')),
	CONSTRAINT "model_calls_refused_check" CHECK (("model_calls"."status" = 'refused') = ("model_calls"."refusal" is not null)),
	CONSTRAINT "model_calls_trust_check" CHECK ("model_calls"."trust" in ('trusted', 'untrusted')),
	CONSTRAINT "model_calls_credential_kind_check" CHECK ("model_calls"."credential_kind" in ('cloud_contract', 'byok_api_key', 'openrouter')),
	CONSTRAINT "model_calls_cost_status_check" CHECK ("model_calls"."cost_status" in ('reported', 'estimated', 'unpriced', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "model_connections" (
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"credential_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "model_connections_workspace_id_provider_pk" PRIMARY KEY("workspace_id","provider"),
	CONSTRAINT "model_connections_provider_check" CHECK ("model_connections"."provider" in ('anthropic', 'openai', 'google', 'openrouter'))
);
--> statement-breakpoint
CREATE TABLE "model_settings_revisions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "model_settings_revisions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"monthly_budget_micros" bigint NOT NULL,
	"allow_unpriced" boolean NOT NULL,
	"changed_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "model_settings_revisions_budget_check" CHECK ("model_settings_revisions"."monthly_budget_micros" > 0)
);
--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_budget_incidents" ADD CONSTRAINT "model_budget_incidents_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_reservation_fk" FOREIGN KEY ("workspace_id","reservation_id") REFERENCES "public"."budget_reservations"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_connections" ADD CONSTRAINT "model_connections_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_connections" ADD CONSTRAINT "model_connections_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_connections" ADD CONSTRAINT "model_connections_credential_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."credentials"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_settings_revisions" ADD CONSTRAINT "model_settings_revisions_changed_by_user_id_fk" FOREIGN KEY ("changed_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_settings_revisions" ADD CONSTRAINT "model_settings_revisions_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_reservations_workspace_id_kind_created_at_idx" ON "budget_reservations" USING btree ("workspace_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "model_calls_workspace_id_created_at_idx" ON "model_calls" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "model_calls_workspace_id_run_id_idx" ON "model_calls" USING btree ("workspace_id","run_id");--> statement-breakpoint
CREATE INDEX "model_settings_revisions_workspace_id_id_idx" ON "model_settings_revisions" USING btree ("workspace_id","id");