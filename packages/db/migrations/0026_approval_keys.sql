CREATE TABLE "approval_keys" (
	"workspace_id" uuid NOT NULL,
	"key_id" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"key_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "approval_keys_pkey" PRIMARY KEY("workspace_id","key_id")
);
--> statement-breakpoint
ALTER TABLE "approval_keys" ADD CONSTRAINT "approval_keys_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_keys_one_live" ON "approval_keys" USING btree ("workspace_id") WHERE "approval_keys"."retired_at" is null;