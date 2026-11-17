-- Forced RLS on Strategy and marketing plans, same workspace policy as the rest. Nothing is
-- deleted, and versions, step progress and measure readings never change.
ALTER TABLE strategies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE strategies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON strategies
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE strategy_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE strategy_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON strategy_versions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE marketing_plans ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE marketing_plans FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON marketing_plans
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE marketing_plan_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE marketing_plan_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON marketing_plan_versions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE plan_step_progress ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE plan_step_progress FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON plan_step_progress
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE plan_measure_readings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE plan_measure_readings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON plan_measure_readings
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE DELETE ON strategies, marketing_plans FROM direx_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON strategy_versions, marketing_plan_versions, plan_step_progress, plan_measure_readings FROM direx_app;
