-- PostgreSQL checks UPDATE USING for SELECT FOR SHARE. Allow active members to
-- lock the applicable rule while the management policy alone authorizes writes.
BEGIN;
CREATE POLICY api_rules_recording_lock ON public.rules FOR UPDATE TO mjstats_api
  USING (calculation_version='exact_v1' AND mjstats_private.current_league_actor(league_id,false))
  WITH CHECK (false);
COMMIT;
