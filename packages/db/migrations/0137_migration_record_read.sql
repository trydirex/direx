-- The API and the worker refuse to start while migrations are pending (ADR 0029 rule 008), so
-- the app role reads the record. Only the record: no other table in this schema, and no write.
GRANT USAGE ON SCHEMA drizzle TO direx_app;
--> statement-breakpoint
GRANT SELECT ON drizzle.__drizzle_migrations TO direx_app;
