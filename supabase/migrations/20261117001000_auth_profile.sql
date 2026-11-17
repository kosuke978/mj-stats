BEGIN;
-- Fail on orphan Auth references. Do not infer identity from names or IDs.
ALTER TABLE public.users
  ADD COLUMN participant_kind varchar(10) NOT NULL DEFAULT 'legacy',
  ADD COLUMN profile_completed_at timestamptz,
  ADD COLUMN version bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT users_kind_check CHECK (participant_kind IN ('registered', 'guest', 'legacy')),
  ADD CONSTRAINT users_version_check CHECK (version > 0);
-- Only an explicit pre-existing auth_id is evidence of registration.
UPDATE public.users SET participant_kind = 'registered' WHERE auth_id IS NOT NULL;
ALTER TABLE public.users
  ADD CONSTRAINT users_auth_kind_check CHECK (auth_id IS NULL OR participant_kind = 'registered'),
  ADD CONSTRAINT users_auth_id_fkey FOREIGN KEY (auth_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- Roles are cluster-wide and can survive a local database reset. Reuse only
-- roles with exactly the expected safety properties; never upgrade a role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mjstats_api') THEN
    CREATE ROLE mjstats_api LOGIN NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mjstats_auth_validator') THEN
    CREATE ROLE mjstats_auth_validator NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('mjstats_api','mjstats_auth_validator')
    AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls OR rolinherit
      OR rolcanlogin <> (rolname='mjstats_api'))) THEN
    RAISE EXCEPTION 'Unexpected privileges on MJ-Stats roles';
  END IF;
END $$;
-- Supabase's migration owner is not a PostgreSQL superuser. Permit ownership
-- transfer during this transaction, then revoke this temporary membership.
GRANT mjstats_auth_validator TO postgres;
CREATE SCHEMA mjstats_private;
REVOKE ALL ON SCHEMA mjstats_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA mjstats_private TO mjstats_api, mjstats_auth_validator;
GRANT CREATE ON SCHEMA mjstats_private TO mjstats_auth_validator;
GRANT SELECT (id, email_confirmed_at, banned_until, deleted_at)
  ON auth.users TO mjstats_auth_validator;
GRANT SELECT (id, user_id, not_after)
  ON auth.sessions TO mjstats_auth_validator;
-- Supabase's postgres role cannot grant UPDATE on Auth-owned tables or create
-- their RLS policies. The explicit, Auth-owner permission phase in
-- supabase/permissions/step1_auth.sql is required after migrations. Until then
-- the locking function fails closed (Go returns 503).

-- FOR SHARE (not KEY SHARE) also orders updates of deleted_at/not_after.
-- Locks live until the caller's transaction ends; the function never changes Auth.
CREATE FUNCTION mjstats_private.valid_session(subject uuid, session uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  confirmed timestamptz;
  banned timestamptz;
  deleted timestamptz;
  session_owner uuid;
  deadline timestamptz;
BEGIN
  SELECT u.email_confirmed_at, u.banned_until, u.deleted_at
    INTO confirmed, banned, deleted FROM auth.users AS u
    WHERE u.id = subject FOR SHARE;
  IF NOT FOUND OR confirmed IS NULL OR deleted IS NOT NULL
     OR (banned IS NOT NULL AND banned > clock_timestamp()) THEN
    RETURN false;
  END IF;
  SELECT s.user_id, s.not_after INTO session_owner, deadline
    FROM auth.sessions AS s WHERE s.id = session FOR SHARE;
  RETURN FOUND AND session_owner = subject
    AND (deadline IS NULL OR deadline > clock_timestamp());
END;
$$;
ALTER FUNCTION mjstats_private.valid_session(uuid, uuid) OWNER TO mjstats_auth_validator;
REVOKE CREATE ON SCHEMA mjstats_private FROM mjstats_auth_validator;
REVOKE ALL ON FUNCTION mjstats_private.valid_session(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mjstats_private.valid_session(uuid, uuid) TO mjstats_api;
REVOKE mjstats_auth_validator FROM postgres;

GRANT USAGE ON SCHEMA public TO mjstats_api;
REVOKE ALL ON public.users, public.leagues, public.league_members, public.seasons,
  public.rules, public.matches, public.match_results FROM anon, authenticated;
GRANT SELECT ON public.users, public.matches, public.match_results TO mjstats_api;
GRANT INSERT (auth_id, name, participant_kind) ON public.users TO mjstats_api;
GRANT UPDATE (name, profile_completed_at, version) ON public.users TO mjstats_api;
GRANT INSERT ON public.matches, public.match_results TO mjstats_api;
CREATE POLICY api_users_read ON public.users FOR SELECT TO mjstats_api USING (true);
CREATE POLICY api_users_create ON public.users FOR INSERT TO mjstats_api
  WITH CHECK (participant_kind = 'registered' AND auth_id IS NOT NULL AND profile_completed_at IS NULL);
CREATE POLICY api_users_name ON public.users FOR UPDATE TO mjstats_api
  USING (participant_kind = 'registered' AND auth_id IS NOT NULL)
  WITH CHECK (participant_kind = 'registered' AND auth_id IS NOT NULL);
CREATE POLICY api_matches_read ON public.matches FOR SELECT TO mjstats_api USING (true);
CREATE POLICY api_matches_create ON public.matches FOR INSERT TO mjstats_api WITH CHECK (true);
CREATE POLICY api_results_read ON public.match_results FOR SELECT TO mjstats_api USING (true);
CREATE POLICY api_results_create ON public.match_results FOR INSERT TO mjstats_api WITH CHECK (true);
-- Step 1 authenticates the legacy match API. League authorization is Step 2.
-- No DELETE grants, table ownership, BYPASSRLS, or direct Auth access for the API.
COMMIT;
