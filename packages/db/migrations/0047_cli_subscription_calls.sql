ALTER TABLE "model_calls" DROP CONSTRAINT "model_calls_credential_kind_check";--> statement-breakpoint
ALTER TABLE "model_calls" DROP CONSTRAINT "model_calls_cost_status_check";--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_credential_kind_check" CHECK ("model_calls"."credential_kind" in ('cloud_contract', 'byok_api_key', 'openrouter', 'cli_subscription'));--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_cost_status_check" CHECK ("model_calls"."cost_status" in ('reported', 'estimated', 'unpriced', 'unknown', 'subscription'));