CREATE TABLE "newsletter_issues" (
	"workspace_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"slot" timestamp with time zone NOT NULL,
	"item_id" uuid NOT NULL,
	"provider_ref" text,
	"sent_at" timestamp with time zone,
	"stats" jsonb,
	"stats_read_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "newsletter_issues_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "newsletter_issues_slot_unique" UNIQUE("workspace_id","slot")
);
--> statement-breakpoint
CREATE TABLE "newsletter_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"list" text NOT NULL,
	"credential_id" uuid,
	"weekday" smallint NOT NULL,
	"send_time" text NOT NULL,
	"time_zone" text NOT NULL,
	"enabled" boolean NOT NULL,
	"read_only_since" timestamp with time zone,
	"last_sent_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "newsletter_settings_list_check" CHECK (("newsletter_settings"."list" = 'connected' and "newsletter_settings"."credential_id" is not null) or ("newsletter_settings"."list" = 'substack' and "newsletter_settings"."credential_id" is null)),
	CONSTRAINT "newsletter_settings_weekday_check" CHECK ("newsletter_settings"."weekday" between 1 and 7),
	CONSTRAINT "newsletter_settings_send_time_check" CHECK ("newsletter_settings"."send_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);
--> statement-breakpoint
ALTER TABLE "newsletter_issues" ADD CONSTRAINT "newsletter_issues_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_issues" ADD CONSTRAINT "newsletter_issues_item_fk" FOREIGN KEY ("workspace_id","item_id") REFERENCES "public"."items"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_settings" ADD CONSTRAINT "newsletter_settings_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_settings" ADD CONSTRAINT "newsletter_settings_credential_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."credentials"("workspace_id","id") ON DELETE no action ON UPDATE no action;