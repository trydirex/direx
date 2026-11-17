-- One pending invite per email per Workspace. Duplicates made before this keep only the
-- newest; the older ones are withdrawn and the withdrawal is in the audit log. Runs as the
-- owner, which bypasses row-level security, so every Workspace's rows are covered.
WITH older AS (
  UPDATE "workspace_invites" i SET "revoked_at" = now()
  WHERE i."accepted_at" IS NULL AND i."revoked_at" IS NULL
    AND EXISTS (
      SELECT 1 FROM "workspace_invites" n
      WHERE n."workspace_id" = i."workspace_id" AND n."email" = i."email"
        AND n."accepted_at" IS NULL AND n."revoked_at" IS NULL
        AND (n."created_at", n."id") > (i."created_at", i."id")
    )
  RETURNING i."workspace_id", i."email"
)
INSERT INTO "workspace_audit" ("workspace_id", "event", "subject_email", "actor_system", "at")
SELECT "workspace_id", 'invite.revoked', "email", 'system', now() FROM older;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_invites_one_pending" ON "workspace_invites" USING btree ("workspace_id","email") WHERE "workspace_invites"."accepted_at" is null and "workspace_invites"."revoked_at" is null;
