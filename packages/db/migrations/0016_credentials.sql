CREATE TABLE "credential_access_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "credential_access_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"consumer" text NOT NULL,
	"action_id" uuid,
	"actor_user_id" uuid,
	"outcome" text NOT NULL,
	"error_code" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "credential_access_events_consumer_check" CHECK ("credential_access_events"."consumer" in ('execute', 'reconcile', 'query', 'poll', 'model_call', 'mcp_call', 'create', 'rotate', 'connect', 'disconnect', 'delete')),
	CONSTRAINT "credential_access_events_outcome_check" CHECK ("credential_access_events"."outcome" in ('ok', 'refreshed', 'needs_reauth', 'refused', 'error'))
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"owner_user_id" uuid,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"connection" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"ciphertext" "bytea",
	"nonce" "bytea",
	"key_version" integer NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_rotated_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "credentials_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "credentials_scope_check" CHECK ("credentials"."scope" in ('workspace', 'user')),
	CONSTRAINT "credentials_owner_check" CHECK (("credentials"."scope" = 'user') = ("credentials"."owner_user_id" is not null)),
	CONSTRAINT "credentials_kind_check" CHECK ("credentials"."kind" in ('oauth2', 'api_key', 'header', 'basic', 'secret')),
	CONSTRAINT "credentials_oauth2_check" CHECK (("credentials"."kind" = 'oauth2') = ("credentials"."connection" is not null) and ("credentials"."kind" <> 'oauth2' or "credentials"."scope" = 'user')),
	CONSTRAINT "credentials_status_check" CHECK ("credentials"."status" in ('active', 'needs_reauth', 'revoked')),
	CONSTRAINT "credentials_value_check" CHECK (("credentials"."deleted_at" is null) = ("credentials"."ciphertext" is not null) and ("credentials"."ciphertext" is null) = ("credentials"."nonce" is null))
);
--> statement-breakpoint
CREATE TABLE "workspace_keys" (
	"workspace_id" uuid NOT NULL,
	"key_version" integer NOT NULL,
	"wrapped_dek" "bytea" NOT NULL,
	"root_key_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "workspace_keys_pkey" PRIMARY KEY("workspace_id","key_version")
);
--> statement-breakpoint
ALTER TABLE "credential_access_events" ADD CONSTRAINT "credential_access_events_credential_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."credentials"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_access_events" ADD CONSTRAINT "credential_access_events_action_fk" FOREIGN KEY ("workspace_id","action_id") REFERENCES "public"."actions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_key_fk" FOREIGN KEY ("workspace_id","key_version") REFERENCES "public"."workspace_keys"("workspace_id","key_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_keys" ADD CONSTRAINT "workspace_keys_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credential_access_events_credential_at_idx" ON "credential_access_events" USING btree ("workspace_id","credential_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_workspace_key" ON "credentials" USING btree ("workspace_id","key") WHERE "credentials"."scope" = 'workspace' and "credentials"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_user_key" ON "credentials" USING btree ("workspace_id","owner_user_id","key") WHERE "credentials"."scope" = 'user' and "credentials"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_keys_one_active" ON "workspace_keys" USING btree ("workspace_id") WHERE "workspace_keys"."retired_at" is null;