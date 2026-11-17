CREATE TABLE "deployment_root_key" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"root_key_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "deployment_root_key_singleton_check" CHECK ("deployment_root_key"."singleton")
);
