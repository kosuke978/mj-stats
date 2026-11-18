-- Step 2 / 2-2: attribution and references. The old API still writes legacy.
BEGIN;

ALTER TABLE public.matches
  ADD COLUMN league_id uuid REFERENCES public.leagues(id) ON DELETE RESTRICT,
  ADD COLUMN match_date timestamptz,
  ADD COLUMN data_origin varchar(10) NOT NULL DEFAULT 'legacy',
  ADD CONSTRAINT matches_origin_check CHECK (
    (data_origin = 'legacy' AND league_id IS NULL)
    OR (data_origin = 'app' AND league_id IS NOT NULL AND rule_id IS NOT NULL
        AND recorded_by IS NOT NULL AND match_date IS NOT NULL)
  ),
  ADD CONSTRAINT matches_league_id_id_key UNIQUE (league_id, id),
  ADD CONSTRAINT matches_id_origin_key UNIQUE (id, data_origin),
  ADD CONSTRAINT matches_league_rule_fkey FOREIGN KEY (league_id, rule_id)
    REFERENCES public.rules(league_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT matches_league_season_fkey FOREIGN KEY (league_id, season_id)
    REFERENCES public.seasons(league_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT matches_league_recorder_fkey FOREIGN KEY (league_id, recorded_by)
    REFERENCES public.league_members(league_id, user_id) ON DELETE RESTRICT,
  DROP CONSTRAINT matches_season_id_fkey,
  ADD CONSTRAINT matches_season_id_fkey FOREIGN KEY (season_id)
    REFERENCES public.seasons(id) ON DELETE RESTRICT;

ALTER TABLE public.match_results
  ADD COLUMN league_id uuid,
  -- A NULL league bypasses a normal composite FK. This derived key still
  -- checks the parent origin for every non-NULL match ID, including legacy.
  ADD COLUMN data_origin varchar(10) GENERATED ALWAYS AS (
    CASE WHEN league_id IS NULL THEN 'legacy' ELSE 'app' END
  ) STORED NOT NULL,
  ADD CONSTRAINT match_results_app_refs_check CHECK (
    league_id IS NULL OR (match_id IS NOT NULL AND user_id IS NOT NULL)
  ),
  ADD CONSTRAINT match_results_league_match_fkey FOREIGN KEY (league_id, match_id)
    REFERENCES public.matches(league_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT match_results_match_origin_fkey FOREIGN KEY (match_id, data_origin)
    REFERENCES public.matches(id, data_origin) ON DELETE RESTRICT,
  ADD CONSTRAINT match_results_league_member_fkey FOREIGN KEY (league_id, user_id)
    REFERENCES public.league_members(league_id, user_id) ON DELETE RESTRICT,
  DROP CONSTRAINT match_results_match_id_fkey,
  ADD CONSTRAINT match_results_match_id_fkey FOREIGN KEY (match_id)
    REFERENCES public.matches(id) ON DELETE RESTRICT;

CREATE INDEX matches_league_history_idx ON public.matches (
  league_id, (COALESCE(match_date, created_at)) DESC NULLS LAST,
  created_at DESC NULLS LAST, id DESC
);
CREATE INDEX matches_league_season_idx ON public.matches (league_id, season_id);
CREATE INDEX matches_season_id_idx ON public.matches (season_id);
CREATE INDEX matches_rule_league_idx ON public.matches (rule_id, league_id);
CREATE INDEX matches_recorder_league_idx ON public.matches (recorded_by, league_id);
CREATE INDEX match_results_user_league_idx ON public.match_results (user_id, league_id);

-- Keep the old authenticated operation in its legacy lane. The 2-3 read
-- cutover and Step 3 validated attributed saves need separate policy changes.
REVOKE ALL ON public.matches, public.match_results FROM PUBLIC, anon, authenticated;
REVOKE INSERT ON public.matches, public.match_results FROM mjstats_api;
GRANT INSERT (rule_id, season_id, created_at) ON public.matches TO mjstats_api;
GRANT INSERT (match_id, user_id, raw_score, final_point, rank) ON public.match_results TO mjstats_api;
ALTER POLICY api_matches_read ON public.matches USING (data_origin = 'legacy');
ALTER POLICY api_results_read ON public.match_results USING (data_origin = 'legacy');
ALTER POLICY api_matches_create ON public.matches WITH CHECK (
  data_origin = 'legacy' AND league_id IS NULL AND rule_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.rules r WHERE r.id = matches.rule_id)
);
ALTER POLICY api_results_create ON public.match_results WITH CHECK (
  data_origin = 'legacy' AND match_id IS NOT NULL AND user_id IS NOT NULL
);

COMMIT;
