-- Why a list is read-only, in the tool's words, such as the plan it needs. Cleared with read_only_since.
ALTER TABLE newsletter_settings ADD COLUMN read_only_reason text;
--> statement-breakpoint
ALTER TABLE newsletter_settings ADD CONSTRAINT newsletter_settings_read_only_check CHECK ((read_only_since IS NULL) = (read_only_reason IS NULL));
