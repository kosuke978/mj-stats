-- Step 5: retain the existing creation revisions and append corrections and cancellations.
BEGIN;

ALTER TABLE public.match_revisions
  DROP CONSTRAINT match_revisions_operation_check,
  DROP CONSTRAINT match_revisions_version_check,
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  ADD COLUMN before jsonb,
  ADD COLUMN reason text,
  ADD CONSTRAINT match_revisions_transition_check CHECK (
    (operation='create' AND version=1 AND before IS NULL AND reason IS NULL)
    OR (operation IN ('update','cancel') AND version>1 AND before IS NOT NULL
      AND jsonb_typeof(before)='object' AND reason IS NOT NULL AND char_length(reason) BETWEEN 1 AND 500)
  );
CREATE UNIQUE INDEX match_revisions_mutation_key
  ON public.match_revisions(league_id,actor_id,client_request_id) WHERE operation<>'create';
CREATE INDEX match_revisions_page ON public.match_revisions(match_id,created_at DESC,id DESC);

CREATE FUNCTION mjstats_private.current_league_actor(target_league uuid, manager boolean)
RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT mjstats_private.active_league_actor(target_league,
    NULLIF(current_setting('mjstats.league_actor_id', true), '')::uuid, manager)
$$;
REVOKE ALL ON FUNCTION mjstats_private.current_league_actor(uuid, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mjstats_private.current_league_actor(uuid, boolean) TO mjstats_api;

GRANT SELECT ON public.match_revisions TO mjstats_api;
GRANT INSERT (before,reason) ON public.match_revisions TO mjstats_api;
GRANT UPDATE (rule_id,season_id,match_date,status,version) ON public.matches TO mjstats_api;
GRANT UPDATE (user_id,raw_score,rank,final_point_numerator,final_point_denominator)
  ON public.match_results TO mjstats_api;

CREATE POLICY api_match_revision_read ON public.match_revisions FOR SELECT TO mjstats_api
  USING (mjstats_private.current_league_actor(league_id,true));
ALTER POLICY api_exact_revision_create ON public.match_revisions WITH CHECK (
  operation='create' AND mjstats_private.active_league_actor(league_id,actor_id,false)
  AND EXISTS (SELECT 1 FROM public.matches m WHERE m.league_id=match_revisions.league_id
    AND m.id=match_revisions.match_id AND m.recorded_by=match_revisions.actor_id
    AND m.client_request_id=match_revisions.client_request_id AND m.request_hash=match_revisions.request_hash)
);
CREATE POLICY api_match_revision_append ON public.match_revisions FOR INSERT TO mjstats_api WITH CHECK (
  operation IN ('update','cancel') AND mjstats_private.active_league_actor(league_id,actor_id,true)
  AND EXISTS (SELECT 1 FROM public.matches m WHERE m.league_id=match_revisions.league_id
    AND m.id=match_revisions.match_id AND m.version=match_revisions.version AND m.client_request_id IS NOT NULL
    AND ((operation='cancel')=(m.status='cancelled')))
);
CREATE POLICY api_match_manage ON public.matches FOR UPDATE TO mjstats_api
  USING (data_origin='app' AND client_request_id IS NOT NULL AND status='valid'
    AND mjstats_private.current_league_actor(league_id,true))
  WITH CHECK (data_origin='app' AND client_request_id IS NOT NULL
    AND mjstats_private.current_league_actor(league_id,true));
CREATE POLICY api_match_result_manage ON public.match_results FOR UPDATE TO mjstats_api
  USING (data_origin='app' AND mjstats_private.current_league_actor(league_id,true)
    AND EXISTS (SELECT 1 FROM public.matches m WHERE m.id=match_id AND m.status='valid'
      AND m.client_request_id IS NOT NULL))
  WITH CHECK (data_origin='app' AND mjstats_private.current_league_actor(league_id,true)
    AND EXISTS (SELECT 1 FROM public.matches m WHERE m.id=match_id AND m.status='valid'
      AND m.client_request_id IS NOT NULL)
    AND EXISTS (SELECT 1 FROM public.league_members m WHERE m.league_id=match_results.league_id
      AND m.user_id=match_results.user_id AND m.status='active' AND m.participant_kind IN ('registered','guest')));

CREATE FUNCTION mjstats_private.check_match_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $$
BEGIN
  IF NEW.client_request_id IS NOT NULL AND (
    OLD.status <> 'valid' OR NEW.version <> OLD.version+1 OR NOT EXISTS (
      SELECT 1 FROM public.match_revisions v WHERE v.match_id=NEW.id AND v.version=NEW.version
        AND v.operation=CASE WHEN NEW.status='cancelled' THEN 'cancel' ELSE 'update' END
    )
  ) THEN
    RAISE EXCEPTION 'Missing or invalid match transition' USING ERRCODE='23514', CONSTRAINT='match_transition';
  END IF;
  RETURN NULL;
END;
$$;
ALTER FUNCTION mjstats_private.check_match_transition() OWNER TO postgres;
REVOKE ALL ON FUNCTION mjstats_private.check_match_transition() FROM PUBLIC, anon, authenticated, service_role, mjstats_api;
CREATE CONSTRAINT TRIGGER match_transition AFTER UPDATE ON public.matches
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mjstats_private.check_match_transition();

COMMIT;
