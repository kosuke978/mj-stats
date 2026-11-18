BEGIN;

CREATE INDEX leagues_search_name_id ON public.leagues
  ((lower(normalize(name, NFKC) COLLATE pg_catalog."und-x-icu") COLLATE "C"), id)
  WHERE search_listed AND group_number IS NOT NULL;

ALTER TABLE public.league_events
  ADD COLUMN join_invite_id uuid,
  ADD CONSTRAINT league_events_join_target_check CHECK (
    (operation = 'league.join' AND join_invite_id IS NOT NULL AND target = actor_id AND after = '{}'::jsonb)
    OR (operation <> 'league.join' AND join_invite_id IS NULL)),
  ADD CONSTRAINT league_events_join_invite_fkey FOREIGN KEY (league_id, join_invite_id)
    REFERENCES public.league_invites (league_id, id) ON DELETE RESTRICT;
CREATE INDEX league_events_join_invite_idx ON public.league_events(league_id, join_invite_id)
  WHERE join_invite_id IS NOT NULL;
GRANT INSERT (join_invite_id) ON public.league_events TO mjstats_api;
CREATE POLICY api_join_event_read ON public.league_events FOR SELECT TO mjstats_api
  USING (operation='league.join' AND actor_id=NULLIF(current_setting('mjstats.league_actor_id',true),'')::uuid);
CREATE POLICY api_join_event_append ON public.league_events FOR INSERT TO mjstats_api
  WITH CHECK (operation='league.join'
    AND league_id=NULLIF(current_setting('mjstats.join_league_id',true),'')::uuid
    AND actor_id=NULLIF(current_setting('mjstats.league_actor_id',true),'')::uuid
    AND EXISTS (SELECT 1 FROM public.league_members m JOIN public.users u ON u.id=m.user_id
      WHERE m.league_id=league_events.league_id AND m.user_id=league_events.actor_id
        AND m.status='active' AND m.participant_kind='registered'
        AND u.auth_id IS NOT NULL AND u.profile_completed_at IS NOT NULL));

-- Only the digest and invite identity are needed to perform a constant-time
-- comparison in Go. Replay can resolve a revoked invite through the actor's
-- own operation record. The invitation table itself remains operator scoped.
CREATE FUNCTION mjstats_private.join_invite(target_league uuid, actor uuid, replay uuid)
RETURNS TABLE (id uuid, credential_hash char(64), expires_at timestamptz)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT i.id,i.credential_hash,i.expires_at
  FROM public.league_invites i
  WHERE i.league_id=target_league
    AND EXISTS (SELECT 1 FROM public.users u WHERE u.id=actor AND u.participant_kind='registered'
      AND u.auth_id IS NOT NULL AND u.profile_completed_at IS NOT NULL)
    AND CASE WHEN replay IS NULL THEN i.revoked_at IS NULL AND i.expires_at>clock_timestamp()
         ELSE EXISTS (SELECT 1 FROM public.league_events e WHERE e.league_id=target_league
           AND e.actor_id=actor AND actor=NULLIF(current_setting('mjstats.league_actor_id',true),'')::uuid
           AND e.operation='league.join' AND e.client_request_id=replay AND e.join_invite_id=i.id) END;
$$;
ALTER FUNCTION mjstats_private.join_invite(uuid,uuid,uuid) OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION mjstats_private.join_invite(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mjstats_private.join_invite(uuid,uuid,uuid) TO mjstats_api;

CREATE TABLE public.api_rate_limits (
  bucket_key char(64) NOT NULL CHECK (bucket_key ~ '^[0-9a-f]{64}$'),
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts>0),
  PRIMARY KEY (bucket_key, window_start)
);
CREATE INDEX api_rate_limits_window_idx ON public.api_rate_limits(window_start);
ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_rate_limits FROM PUBLIC, anon, authenticated, service_role, mjstats_api;

CREATE FUNCTION mjstats_private.count_attempt(keys text[])
RETURNS TABLE (bucket_key text, attempts integer, retry_after integer)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  WITH current_window AS MATERIALIZED (
    SELECT date_bin(interval '1 minute',clock_timestamp(),'2000-01-01 UTC'::timestamptz) AS start
  ), counted AS (
    INSERT INTO public.api_rate_limits AS limits(bucket_key,window_start,attempts)
    SELECT k,start,1 FROM current_window CROSS JOIN (SELECT DISTINCT unnest(keys) AS k) inputs ORDER BY k
    ON CONFLICT (bucket_key,window_start) DO UPDATE
      SET attempts=LEAST(limits.attempts::bigint+1,2147483647)::integer
    RETURNING limits.bucket_key,limits.attempts
  )
  SELECT counted.bucket_key::text,counted.attempts,
    GREATEST(1,ceil(extract(epoch FROM start+interval '1 minute'-clock_timestamp())))::integer
  FROM counted CROSS JOIN current_window;
$$;

CREATE FUNCTION mjstats_private.prune_attempts() RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  DELETE FROM public.api_rate_limits WHERE window_start<clock_timestamp()-interval '2 minutes';
$$;
ALTER FUNCTION mjstats_private.count_attempt(text[]) OWNER TO postgres;
ALTER FUNCTION mjstats_private.prune_attempts() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION mjstats_private.count_attempt(text[]), mjstats_private.prune_attempts() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mjstats_private.count_attempt(text[]), mjstats_private.prune_attempts() TO mjstats_api;

COMMIT;
