-- Step 3: preserve legacy values and enable only scoped, exact recording.
BEGIN;

ALTER TABLE public.match_results
  ALTER COLUMN final_point DROP NOT NULL,
  ADD COLUMN final_point_numerator bigint,
  ADD COLUMN final_point_denominator integer;

UPDATE public.match_results
SET final_point_numerator = (final_point * 10)::bigint / gcd((final_point * 10)::bigint,10::bigint),
    final_point_denominator = 10 / gcd((final_point * 10)::bigint,10::bigint);

ALTER TABLE public.match_results
  ALTER COLUMN final_point_numerator SET NOT NULL,
  ALTER COLUMN final_point_denominator SET NOT NULL,
  ADD CONSTRAINT match_results_exact_point_check CHECK (
    final_point_denominator > 0
    AND gcd(final_point_numerator::numeric,final_point_denominator::numeric)=1
    AND (final_point IS NULL OR final_point * final_point_denominator = final_point_numerator)
    AND (data_origin <> 'legacy' OR final_point IS NOT NULL)
  );

ALTER TABLE public.matches
  ADD COLUMN client_request_id uuid,
  ADD COLUMN request_hash char(64),
  ADD COLUMN status text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','cancelled')),
  ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD CONSTRAINT matches_recording_key UNIQUE (league_id,recorded_by,client_request_id),
  ADD CONSTRAINT matches_recording_check CHECK (
    (client_request_id IS NULL AND request_hash IS NULL)
    OR (data_origin='app' AND client_request_id IS NOT NULL AND request_hash IS NOT NULL
        AND request_hash ~ '^[0-9a-f]{64}$' AND created_at IS NOT NULL)
  );

CREATE TABLE public.match_revisions (
  league_id uuid NOT NULL,
  match_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation='create'),
  version bigint NOT NULL CHECK (version=1),
  client_request_id uuid NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  after jsonb NOT NULL CHECK (jsonb_typeof(after)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id,version),
  UNIQUE (league_id,actor_id,operation,client_request_id),
  FOREIGN KEY (league_id,match_id) REFERENCES public.matches(league_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id,actor_id) REFERENCES public.league_members(league_id,user_id) ON DELETE RESTRICT
);
ALTER TABLE public.match_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.match_revisions FROM PUBLIC, anon, authenticated, service_role;

-- Cross-row invariants are checked after the last result and creation record
-- have been written. Each term is scaled by an integer common denominator.
CREATE FUNCTION mjstats_private.validate_exact_match(target uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  game record;
  player record;
  total_score bigint := 0;
  total_n numeric := 0;
  total_d numeric := 1;
  players integer := 0;
  canonical uuid[] := ARRAY[]::uuid[];
BEGIN
  SELECT m.*, r.default_points, r.calculation_version INTO game
    FROM public.matches m JOIN public.rules r ON r.id=m.rule_id
    WHERE m.id=target AND m.client_request_id IS NOT NULL;
  IF NOT FOUND THEN RETURN; END IF;

  FOR player IN SELECT r.*, COALESCE(p.registered_user_id,r.user_id) AS person
    FROM public.match_results r LEFT JOIN public.participant_links p
      ON p.league_id=r.league_id AND p.guest_user_id=r.user_id AND p.status='active'
    WHERE r.match_id=target LOOP
    IF player.final_point IS NOT NULL OR player.raw_score % 100 <> 0 OR player.person=ANY(canonical) THEN
      RAISE EXCEPTION 'Invalid exact match result' USING ERRCODE='23514', CONSTRAINT='exact_match_complete';
    END IF;
    canonical := array_append(canonical,player.person);
    players := players + 1;
    total_score := total_score + player.raw_score;
    total_n := total_n * player.final_point_denominator + player.final_point_numerator::numeric * total_d;
    total_d := total_d * player.final_point_denominator;
  END LOOP;

  IF players <> 4 OR game.calculation_version <> 'exact_v1'
    OR total_score <> 4::bigint * game.default_points OR total_n <> 0
    OR NOT EXISTS (SELECT 1 FROM public.match_revisions v WHERE v.match_id=target
      AND v.actor_id=game.recorded_by AND v.client_request_id=game.client_request_id AND v.request_hash=game.request_hash) THEN
    RAISE EXCEPTION 'Incomplete exact match' USING ERRCODE='23514', CONSTRAINT='exact_match_complete';
  END IF;
END;
$$;

CREATE FUNCTION mjstats_private.check_exact_match()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME='matches' THEN
    PERFORM mjstats_private.validate_exact_match(NEW.id);
  ELSE
    IF TG_OP <> 'DELETE' THEN
      PERFORM mjstats_private.validate_exact_match(NEW.match_id);
    END IF;
    IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND OLD.match_id IS DISTINCT FROM NEW.match_id) THEN
      PERFORM mjstats_private.validate_exact_match(OLD.match_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
ALTER FUNCTION mjstats_private.check_exact_match() SECURITY DEFINER;
ALTER FUNCTION mjstats_private.check_exact_match() OWNER TO postgres;
ALTER FUNCTION mjstats_private.validate_exact_match(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION mjstats_private.check_exact_match(), mjstats_private.validate_exact_match(uuid)
  FROM PUBLIC, anon, authenticated, service_role, mjstats_api;

CREATE CONSTRAINT TRIGGER exact_match_complete
  AFTER INSERT OR UPDATE ON public.matches
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mjstats_private.check_exact_match();
CREATE CONSTRAINT TRIGGER exact_match_complete
  AFTER INSERT OR UPDATE OR DELETE ON public.match_results
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mjstats_private.check_exact_match();
CREATE CONSTRAINT TRIGGER exact_match_complete
  AFTER UPDATE OR DELETE ON public.match_revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mjstats_private.check_exact_match();

GRANT INSERT (league_id,rule_id,season_id,recorded_by,match_date,data_origin,client_request_id,request_hash)
  ON public.matches TO mjstats_api;
GRANT INSERT (league_id,match_id,user_id,raw_score,rank,final_point_numerator,final_point_denominator)
  ON public.match_results TO mjstats_api;
GRANT INSERT (league_id,match_id,actor_id,operation,version,client_request_id,request_hash,after)
  ON public.match_revisions TO mjstats_api;

CREATE POLICY api_exact_match_create ON public.matches FOR INSERT TO mjstats_api WITH CHECK (
  data_origin='app' AND client_request_id IS NOT NULL AND match_date <= statement_timestamp()
  AND mjstats_private.active_league_actor(league_id,recorded_by,false)
  AND EXISTS (SELECT 1 FROM public.rules r WHERE r.league_id=matches.league_id AND r.id=rule_id AND r.available)
  AND (season_id IS NULL OR EXISTS (SELECT 1 FROM public.seasons s
    WHERE s.league_id=matches.league_id AND s.id=matches.season_id
      AND (s.start_date IS NULL OR (match_date AT TIME ZONE 'Asia/Tokyo')::date >= s.start_date)
      AND (s.end_date IS NULL OR (match_date AT TIME ZONE 'Asia/Tokyo')::date <= s.end_date)))
);
CREATE POLICY api_exact_result_create ON public.match_results FOR INSERT TO mjstats_api WITH CHECK (
  league_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM public.matches m WHERE m.league_id=match_results.league_id
    AND m.id=match_results.match_id AND m.client_request_id IS NOT NULL
    AND mjstats_private.active_league_actor(m.league_id,m.recorded_by,false))
  AND EXISTS (SELECT 1 FROM public.league_members p WHERE p.league_id=match_results.league_id
    AND p.user_id=match_results.user_id AND p.status='active' AND p.participant_kind IN ('guest','registered'))
);
CREATE POLICY api_exact_revision_create ON public.match_revisions FOR INSERT TO mjstats_api WITH CHECK (
  mjstats_private.active_league_actor(league_id,actor_id,false)
  AND EXISTS (SELECT 1 FROM public.matches m WHERE m.league_id=match_revisions.league_id
    AND m.id=match_revisions.match_id AND m.recorded_by=match_revisions.actor_id
    AND m.client_request_id=match_revisions.client_request_id AND m.request_hash=match_revisions.request_hash)
);

COMMIT;
