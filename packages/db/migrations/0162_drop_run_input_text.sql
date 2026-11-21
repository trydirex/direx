-- ADR 0008 rule DX-R-0008-025: once a run ends, its record keeps only the kind, id and digest of
-- what it read. Runs have dropped text, request, brief and person at their end since the agent
-- layer began; attached (an Item's text) and history (earlier Ask turns) were kept by mistake. The
-- manifest already holds both as parts with an id and a digest. Live runs still need them.
UPDATE agent_runs SET input = input - 'attached' - 'history'
WHERE ended_at IS NOT NULL AND (input ? 'attached' OR input ? 'history');
