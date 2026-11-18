-- Step 2 / 2-5: one unrevoked invite, secret-free audit, and retry scope.
BEGIN;

CREATE TABLE public.league_invites (
  id uuid PRIMARY KEY,
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE RESTRICT,
  issued_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  key_version integer NOT NULL CHECK (key_version > 0),
  credential_hash char(64) NOT NULL CHECK (credential_hash ~ '^[0-9a-f]{64}$'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (league_id, id),
  CHECK (expires_at = issued_at + interval '168 hours'),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);
CREATE UNIQUE INDEX league_invites_one_unrevoked ON public.league_invites(league_id) WHERE revoked_at IS NULL;
ALTER TABLE public.league_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.league_invites FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.league_invites TO mjstats_api;
GRANT INSERT (id, league_id, issued_by, issued_at, expires_at, key_version, credential_hash)
  ON public.league_invites TO mjstats_api;
GRANT UPDATE (revoked_at, version) ON public.league_invites TO mjstats_api;

-- Go sets both scopes only after authenticating and checking the target league.
CREATE FUNCTION mjstats_private.can_manage_scoped_invites(target_league uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(target_league = NULLIF(current_setting('mjstats.invite_league_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM public.league_members m JOIN public.users u ON u.id=m.user_id
      WHERE m.league_id=target_league
        AND m.user_id=NULLIF(current_setting('mjstats.league_actor_id', true), '')::uuid
        AND m.status='active' AND m.participant_kind='registered' AND m.role IN ('owner','admin')
        AND u.auth_id IS NOT NULL AND u.profile_completed_at IS NOT NULL
    ),false);
$$;
REVOKE EXECUTE ON FUNCTION mjstats_private.can_manage_scoped_invites(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mjstats_private.can_manage_scoped_invites(uuid) TO mjstats_api;

CREATE POLICY api_invite_read ON public.league_invites FOR SELECT TO mjstats_api
  USING (mjstats_private.can_manage_scoped_invites(league_id));
CREATE POLICY api_invite_issue ON public.league_invites FOR INSERT TO mjstats_api
  WITH CHECK (mjstats_private.can_manage_scoped_invites(league_id)
    AND issued_by=NULLIF(current_setting('mjstats.league_actor_id', true), '')::uuid);
CREATE POLICY api_invite_revoke ON public.league_invites FOR UPDATE TO mjstats_api
  USING (revoked_at IS NULL AND mjstats_private.can_manage_scoped_invites(league_id))
  WITH CHECK (revoked_at IS NOT NULL AND mjstats_private.can_manage_scoped_invites(league_id));

ALTER TABLE public.league_events
  ADD COLUMN invite_id uuid GENERATED ALWAYS AS (
    CASE WHEN operation IN ('invite.issue','invite.revoke') THEN target END
  ) STORED,
  ADD CONSTRAINT league_events_invite_fkey
    FOREIGN KEY (league_id, invite_id) REFERENCES public.league_invites(league_id, id) ON DELETE RESTRICT,
  -- Keep audit metadata in typed columns. The invite event payload is empty.
  ADD CONSTRAINT league_events_invite_payload_check CHECK (
    operation NOT IN ('invite.issue','invite.revoke') OR after = '{}'::jsonb
  );
CREATE INDEX league_events_league_invite_idx ON public.league_events(league_id, invite_id)
  WHERE invite_id IS NOT NULL;
GRANT SELECT (invite_id) ON public.league_events TO mjstats_api;
CREATE POLICY api_invite_event_read ON public.league_events FOR SELECT TO mjstats_api
  USING (operation IN ('invite.issue','invite.revoke')
    AND actor_id=NULLIF(current_setting('mjstats.league_actor_id', true), '')::uuid
    AND mjstats_private.can_manage_scoped_invites(league_id));
CREATE POLICY api_invite_event_append ON public.league_events FOR INSERT TO mjstats_api
  WITH CHECK (operation IN ('invite.issue','invite.revoke')
    AND actor_id=NULLIF(current_setting('mjstats.league_actor_id', true), '')::uuid
    AND mjstats_private.can_manage_scoped_invites(league_id));

-- Detect reuse in another league without granting SELECT on that league's
-- event. The caller gets a boolean and no event data.
CREATE FUNCTION mjstats_private.invite_request_used_elsewhere(op text, request_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(op IN ('invite.issue','invite.revoke')
    AND mjstats_private.can_manage_scoped_invites(NULLIF(current_setting('mjstats.invite_league_id', true), '')::uuid)
    AND EXISTS (
      SELECT 1 FROM public.league_events e
      WHERE e.operation=op AND e.client_request_id=request_id
        AND e.actor_id=NULLIF(current_setting('mjstats.league_actor_id', true), '')::uuid
        AND e.league_id<>NULLIF(current_setting('mjstats.invite_league_id', true), '')::uuid
    ),false);
$$;
ALTER FUNCTION mjstats_private.invite_request_used_elsewhere(text, uuid) OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION mjstats_private.invite_request_used_elsewhere(text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mjstats_private.invite_request_used_elsewhere(text, uuid) TO mjstats_api;

COMMIT;
