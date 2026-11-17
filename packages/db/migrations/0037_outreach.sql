CREATE TABLE "outreach_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"sender_name" text,
	"postal_address" text,
	"paused_at" timestamp with time zone,
	"paused_by" uuid,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_eligibility" (
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"country" text NOT NULL,
	"basis" text NOT NULL,
	"evidence" text NOT NULL,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "person_eligibility_workspace_id_person_id_pk" PRIMARY KEY("workspace_id","person_id"),
	CONSTRAINT "person_eligibility_basis_check" CHECK ("person_eligibility"."basis" in ('consent', 'implied', 'legitimate_interest', 'published_address')),
	CONSTRAINT "person_eligibility_country_check" CHECK ("person_eligibility"."country" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "suppressions_workspace_id_email_pk" PRIMARY KEY("workspace_id","email"),
	CONSTRAINT "suppressions_reason_check" CHECK ("suppressions"."reason" in ('unsubscribe', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "unsubscribe_tokens" (
	"workspace_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "unsubscribe_tokens_workspace_id_token_hash_pk" PRIMARY KEY("workspace_id","token_hash")
);
--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "outcome_unknown_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outreach_settings" ADD CONSTRAINT "outreach_settings_paused_by_user_id_fk" FOREIGN KEY ("paused_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_settings" ADD CONSTRAINT "outreach_settings_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_eligibility" ADD CONSTRAINT "person_eligibility_recorded_by_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_eligibility" ADD CONSTRAINT "person_eligibility_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unsubscribe_tokens" ADD CONSTRAINT "unsubscribe_tokens_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;