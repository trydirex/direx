CREATE TABLE "identity_keys" (
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "identity_keys_pkey" PRIMARY KEY("workspace_id","kind","value")
);
