-- Stop the legacy Go server before applying. Only scoped 2-3 readers may run
-- after the cutover. No row values or existing constraints are changed.
BEGIN;

REVOKE INSERT (rule_id, season_id, created_at) ON public.matches FROM mjstats_api;
REVOKE INSERT (match_id, user_id, raw_score, final_point, rank) ON public.match_results FROM mjstats_api;
DROP POLICY api_matches_create ON public.matches;
DROP POLICY api_results_create ON public.match_results;

-- Go sets this transaction-local scope only after it authorizes the request.
-- The ordinary table SELECT grants alone cannot return matches on old servers.
ALTER POLICY api_matches_read ON public.matches USING (
  data_origin = 'app' AND league_id = NULLIF(current_setting('mjstats.league_id', true),'')::uuid
);
ALTER POLICY api_results_read ON public.match_results USING (
  data_origin = 'app' AND league_id = NULLIF(current_setting('mjstats.league_id', true),'')::uuid
);

COMMIT;
