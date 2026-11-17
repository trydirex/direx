-- The writing transaction of each Item event, so the door's changes reader returns an event only
-- once every older transaction has finished (door-reads spec). Rows already here get 0 through a
-- constant default, which adds the column without rewriting the table; new rows get their own.
ALTER TABLE "item_events" ADD COLUMN "tx" "xid8" DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "item_events" ALTER COLUMN "tx" SET DEFAULT pg_current_xact_id();
