CREATE TABLE "door_counters" (
	"workspace_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"minute" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "door_counters_pkey" PRIMARY KEY("workspace_id","scope","minute"),
	CONSTRAINT "door_counters_count_check" CHECK ("door_counters"."count" > 0)
);
--> statement-breakpoint
CREATE TABLE "door_requests" (
	"id" bigint GENERATED ALWAYS AS IDENTITY (sequence name "door_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"reader" text NOT NULL,
	"outcome" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "door_requests_pkey" PRIMARY KEY("workspace_id","token_id","id"),
	CONSTRAINT "door_requests_outcome_check" CHECK (outcome in ('ok', 'invalid_input', 'reader_not_allowed', 'rate_limited', 'too_large', 'bad_cursor', 'error'))
);
--> statement-breakpoint
ALTER TABLE "door_counters" ADD CONSTRAINT "door_counters_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "door_requests" ADD CONSTRAINT "door_requests_token_fk" FOREIGN KEY ("workspace_id","token_id") REFERENCES "public"."external_tokens"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE door_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE door_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON door_requests
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- The request record is written once and never changed by the app (ADR 0032 rule 011).
REVOKE UPDATE, DELETE ON door_requests FROM direx_app;
--> statement-breakpoint
ALTER TABLE door_counters ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE door_counters FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON door_counters
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
