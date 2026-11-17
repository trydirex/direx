CREATE TABLE "door_proposals" (
	"workspace_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"body_digest" text NOT NULL,
	"kind" text NOT NULL,
	"item_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "door_proposals_pkey" PRIMARY KEY("workspace_id","token_id","idempotency_key"),
	CONSTRAINT "door_proposals_key_check" CHECK (char_length("door_proposals"."idempotency_key") between 1 and 200),
	CONSTRAINT "door_proposals_body_digest_check" CHECK ("door_proposals"."body_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "door_proposals_kind_check" CHECK ("door_proposals"."kind" in ('fact_proposal', 'draft'))
);
--> statement-breakpoint
ALTER TABLE "door_requests" DROP CONSTRAINT "door_requests_outcome_check";--> statement-breakpoint
-- `operation` replaces `reader`, which only fits reads (DX-R-0029-005). Every new row gets both; a later
-- release fills older rows in indexed batches (door_requests is on the large list), makes it NOT NULL
-- and drops `reader`.
ALTER TABLE "door_requests" ADD COLUMN "operation" text;--> statement-breakpoint
ALTER TABLE "door_proposals" ADD CONSTRAINT "door_proposals_token_fk" FOREIGN KEY ("workspace_id","token_id") REFERENCES "public"."external_tokens"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "door_proposals" ADD CONSTRAINT "door_proposals_item_fk" FOREIGN KEY ("workspace_id","item_id") REFERENCES "public"."items"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "door_requests" ADD CONSTRAINT "door_requests_outcome_check" CHECK (outcome in ('ok', 'invalid_input', 'reader_not_allowed', 'rate_limited', 'too_large', 'bad_cursor', 'error', 'kind_not_allowed', 'already_waiting', 'idempotency_conflict', 'proposal_cap', 'refused'));
--> statement-breakpoint
ALTER TABLE door_proposals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE door_proposals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON door_proposals
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- A proposal's record is written once and never changed by the app (ADR 0032 rules 004 and 011).
REVOKE UPDATE, DELETE ON door_proposals FROM direx_app;
