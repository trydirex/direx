-- Roles are cluster-wide, so creation is guarded. Passwords are never set here;
-- each environment sets them from its own secrets.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'direx_app') THEN
    CREATE ROLE direx_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'direx_system') THEN
    CREATE ROLE direx_system LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO direx_app;
--> statement-breakpoint
-- Tables the owner creates from here on are readable and writable by the app, never owned by it.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO direx_app;
--> statement-breakpoint
-- direx_system gets functions only, never table grants.
CREATE SCHEMA system;
--> statement-breakpoint
GRANT USAGE ON SCHEMA system TO direx_system;
