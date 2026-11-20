-- Step 5: exact sums use a common denominator for the stored app results.
BEGIN;
ALTER TABLE public.match_results ADD CONSTRAINT app_results_ranking_denominator
  CHECK (data_origin<>'app' OR 30 % NULLIF(final_point_denominator,0)=0);
CREATE INDEX valid_matches_ranking ON public.matches(league_id,season_id,id)
  WHERE data_origin='app' AND status='valid';
COMMIT;
