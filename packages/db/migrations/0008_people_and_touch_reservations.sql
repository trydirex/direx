CREATE TABLE "people" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"coordination_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "people_workspace_id_id_key" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "person_keys" (
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "person_keys_pkey" PRIMARY KEY("workspace_id","person_id","kind","value"),
	CONSTRAINT "person_keys_kind_check" CHECK ("person_keys"."kind" in ('email', 'phone', 'linkedin', 'hubspot', 'shopify'))
);
--> statement-breakpoint
CREATE TABLE "person_links" (
	"workspace_id" uuid NOT NULL,
	"low_id" uuid NOT NULL,
	"high_id" uuid NOT NULL,
	"state" text NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "person_links_pkey" PRIMARY KEY("workspace_id","low_id","high_id"),
	CONSTRAINT "person_links_order_check" CHECK ("person_links"."low_id" < "person_links"."high_id"),
	CONSTRAINT "person_links_state_check" CHECK ("person_links"."state" in ('proposed', 'merged', 'rejected')),
	CONSTRAINT "person_links_decided_check" CHECK (("person_links"."state" = 'proposed') = ("person_links"."decided_at" is null))
);
--> statement-breakpoint
CREATE TABLE "touch_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"touch_class" text NOT NULL,
	"cap" text NOT NULL,
	"slot" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "touch_reservations_action_cap_slot_key" UNIQUE("workspace_id","action_id","cap","slot"),
	CONSTRAINT "touch_reservations_class_check" CHECK ("touch_reservations"."touch_class" in ('cold', 'sales_follow_up', 'consented_marketing')),
	CONSTRAINT "touch_reservations_cap_check" CHECK ("touch_reservations"."cap" in ('general', 'consented_marketing'))
);
--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_coordination_fk" FOREIGN KEY ("workspace_id","coordination_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_keys" ADD CONSTRAINT "person_keys_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_links" ADD CONSTRAINT "person_links_low_fk" FOREIGN KEY ("workspace_id","low_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_links" ADD CONSTRAINT "person_links_high_fk" FOREIGN KEY ("workspace_id","high_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "touch_reservations" ADD CONSTRAINT "touch_reservations_action_fk" FOREIGN KEY ("workspace_id","action_id") REFERENCES "public"."actions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "touch_reservations" ADD CONSTRAINT "touch_reservations_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "people_workspace_id_coordination_id_idx" ON "people" USING btree ("workspace_id","coordination_id");--> statement-breakpoint
CREATE INDEX "person_keys_workspace_id_kind_value_idx" ON "person_keys" USING btree ("workspace_id","kind","value");--> statement-breakpoint
CREATE INDEX "person_links_workspace_id_high_id_idx" ON "person_links" USING btree ("workspace_id","high_id");--> statement-breakpoint
CREATE INDEX "touch_reservations_workspace_id_person_id_slot_idx" ON "touch_reservations" USING btree ("workspace_id","person_id","slot");