-- Keep writers out between checking existing rows and installing the trigger.
LOCK TABLE public.campaign_outcomes IN SHARE ROW EXCLUSIVE MODE;
-- Fail closed if an earlier writer stored an undo of an undo; audit rows are never rewritten.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.campaign_outcomes u
    JOIN public.campaign_outcomes target ON target.id = u.voids
    WHERE target.voids IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'campaign_outcomes_mark_only: an undo must target a mark'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;
--> statement-breakpoint
CREATE FUNCTION public.campaign_outcomes_mark_only()
RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.campaign_outcomes target
    WHERE target.id = NEW.voids AND target.voids IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'campaign_outcomes_mark_only: an undo must target a mark'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'campaign_outcomes_mark_only';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- AFTER sees all rows of a multi-row insert, including a target listed after its undo.
-- The existing FK still enforces the target's Workspace, Campaign, Person and kind.
CREATE TRIGGER campaign_outcomes_mark_only AFTER INSERT ON public.campaign_outcomes
  FOR EACH ROW WHEN (NEW.voids IS NOT NULL)
  EXECUTE FUNCTION public.campaign_outcomes_mark_only();
