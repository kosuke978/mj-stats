-- Step 2 / 2-2: rule versions and seasons. Preserve all existing values.
BEGIN;

ALTER TABLE public.rules
  ADD COLUMN calculation_version varchar(40) NOT NULL DEFAULT 'legacy_unverified',
  ADD COLUMN available boolean NOT NULL DEFAULT false,
  ADD COLUMN version bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT rules_league_id_id_key UNIQUE (league_id, id),
  ADD CONSTRAINT rules_version_check CHECK (version > 0),
  ADD CONSTRAINT rules_conditions_check CHECK (
    (calculation_version = 'legacy_unverified' AND NOT available)
    OR (
      calculation_version = 'exact_v1' AND league_id IS NOT NULL
      AND default_points IS NOT NULL AND return_points IS NOT NULL
      AND default_points > 0 AND return_points >= default_points
      AND default_points % 100 = 0 AND return_points % 100 = 0
      AND uma_1 >= uma_2 AND uma_2 >= uma_3 AND uma_3 >= uma_4
      AND uma_1::bigint + uma_2 + uma_3 + uma_4 = 0
    )
  );

ALTER TABLE public.seasons
  ADD COLUMN version bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT seasons_league_id_id_key UNIQUE (league_id, id),
  ADD CONSTRAINT seasons_version_check CHECK (version > 0),
  -- Do not correct old dates. CHECK applies to new writes, including imports.
  ADD CONSTRAINT seasons_period_check CHECK (start_date <= end_date) NOT VALID;

REVOKE ALL ON public.rules, public.seasons FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.rules, public.seasons TO mjstats_api;
GRANT INSERT (league_id, name, default_points, return_points, uma_1, uma_2, uma_3, uma_4, calculation_version, available)
  ON public.rules TO mjstats_api;
GRANT UPDATE (available, version) ON public.rules TO mjstats_api;
-- No season updates yet: a later management path must also guard used periods.
GRANT INSERT (league_id, name, start_date, end_date) ON public.seasons TO mjstats_api;

CREATE POLICY api_rules_read ON public.rules FOR SELECT TO mjstats_api
  USING (calculation_version = 'exact_v1'
    AND EXISTS (SELECT 1 FROM public.leagues l WHERE l.id = rules.league_id AND l.group_number IS NOT NULL));
CREATE POLICY api_rules_create ON public.rules FOR INSERT TO mjstats_api
  WITH CHECK (calculation_version = 'exact_v1' AND available
    AND EXISTS (SELECT 1 FROM public.leagues l WHERE l.id = rules.league_id AND l.group_number IS NOT NULL));
CREATE POLICY api_rules_update ON public.rules FOR UPDATE TO mjstats_api
  USING (calculation_version = 'exact_v1'
    AND EXISTS (SELECT 1 FROM public.leagues l WHERE l.id = rules.league_id AND l.group_number IS NOT NULL))
  WITH CHECK (calculation_version = 'exact_v1'
    AND EXISTS (SELECT 1 FROM public.leagues l WHERE l.id = rules.league_id AND l.group_number IS NOT NULL));
CREATE POLICY api_seasons_read ON public.seasons FOR SELECT TO mjstats_api
  USING (EXISTS (SELECT 1 FROM public.leagues l WHERE l.id = seasons.league_id AND l.group_number IS NOT NULL));
CREATE POLICY api_seasons_create ON public.seasons FOR INSERT TO mjstats_api
  WITH CHECK (EXISTS (SELECT 1 FROM public.leagues l WHERE l.id = seasons.league_id AND l.group_number IS NOT NULL));

COMMIT;
