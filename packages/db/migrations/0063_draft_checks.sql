ALTER TABLE "campaign_actions" ADD COLUMN "checks" jsonb;--> statement-breakpoint
-- Warnings were plain words; each becomes a code and the same words. Runs as the owner, which
-- bypasses row-level security, so every Workspace's rows are rewritten.
UPDATE "items" SET "warnings" = (
  SELECT coalesce(jsonb_agg(CASE WHEN jsonb_typeof(e) = 'string' THEN jsonb_build_object('code', 'unspecified', 'text', e) ELSE e END ORDER BY n), '[]'::jsonb)
  FROM jsonb_array_elements("warnings") WITH ORDINALITY AS w(e, n)
) WHERE jsonb_path_exists("warnings", '$[*] ? (@.type() == "string")');--> statement-breakpoint
UPDATE "campaign_steps" SET "template" = jsonb_set(jsonb_set("template",
  '{warnings}', (SELECT coalesce(jsonb_agg(CASE WHEN jsonb_typeof(e) = 'string' THEN jsonb_build_object('code', 'unspecified', 'text', e) ELSE e END ORDER BY n), '[]'::jsonb) FROM jsonb_array_elements(coalesce("template"->'warnings', '[]'::jsonb)) WITH ORDINALITY AS w(e, n))),
  '{needsDecision}', (SELECT coalesce(jsonb_agg(CASE WHEN jsonb_typeof(e) = 'string' THEN jsonb_build_object('code', 'price_conflict', 'text', e) ELSE e END ORDER BY n), '[]'::jsonb) FROM jsonb_array_elements(coalesce("template"->'needsDecision', '[]'::jsonb)) WITH ORDINALITY AS w(e, n)))
WHERE jsonb_typeof("template") = 'object';--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_warnings_shape_check" CHECK (not jsonb_path_exists("items"."warnings", '$[*] ? (@.type() != "object" || !(@.code.type() == "string") || !(@.text.type() == "string"))'));