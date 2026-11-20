BEGIN;

-- Retaining a result may keep a former member. A replacement still requires
-- active membership, checked against OLD and NEW by the trigger below.
ALTER POLICY api_match_result_manage ON public.match_results
  WITH CHECK (data_origin='app' AND mjstats_private.current_league_actor(league_id,true)
    AND EXISTS (SELECT 1 FROM public.matches m WHERE m.id=match_id AND m.status='valid'
      AND m.client_request_id IS NOT NULL)
    AND EXISTS (SELECT 1 FROM public.league_members m WHERE m.league_id=match_results.league_id
      AND m.user_id=match_results.user_id AND m.status IN ('active','left','removed')
      AND m.participant_kind IN ('registered','guest')));

CREATE FUNCTION mjstats_private.check_match_participant_replacement()
RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.league_members m
    WHERE m.league_id=NEW.league_id AND m.user_id=NEW.user_id AND m.status='active'
      AND m.participant_kind IN ('registered','guest')) THEN
    RAISE EXCEPTION 'Replacement participant must be active' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION mjstats_private.check_match_participant_replacement()
  FROM PUBLIC, anon, authenticated, service_role, mjstats_api;
CREATE TRIGGER match_participant_replacement
  BEFORE UPDATE OF user_id ON public.match_results FOR EACH ROW
  WHEN (OLD.data_origin='app' AND OLD.user_id IS DISTINCT FROM NEW.user_id)
  EXECUTE FUNCTION mjstats_private.check_match_participant_replacement();

COMMIT;
