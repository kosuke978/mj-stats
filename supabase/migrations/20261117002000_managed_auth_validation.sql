-- Hosted Supabase does not allow postgres to grant Auth schema USAGE/UPDATE
-- or alter Auth RLS policies. Delegate only these seven metadata columns via
-- private owner-rights views. No Auth-owned objects or credentials are changed.
BEGIN;
CREATE VIEW mjstats_private.auth_subjects
  WITH (security_invoker = false, security_barrier = true) AS
  SELECT id, email_confirmed_at, banned_until, deleted_at FROM auth.users;
CREATE VIEW mjstats_private.auth_sessions
  WITH (security_invoker = false, security_barrier = true) AS
  SELECT id, user_id, not_after FROM auth.sessions;
ALTER VIEW mjstats_private.auth_subjects OWNER TO postgres;
ALTER VIEW mjstats_private.auth_sessions OWNER TO postgres;
REVOKE ALL ON mjstats_private.auth_subjects, mjstats_private.auth_sessions
  FROM PUBLIC, anon, authenticated, service_role, mjstats_api;
GRANT SELECT ON mjstats_private.auth_subjects, mjstats_private.auth_sessions
  TO mjstats_auth_validator;
-- PostgreSQL also requires an UPDATE privilege for SELECT ... FOR SHARE.
GRANT UPDATE (id) ON mjstats_private.auth_subjects, mjstats_private.auth_sessions
  TO mjstats_auth_validator;

-- Row locking must be possible, but actual view updates must never reach Auth.
CREATE FUNCTION mjstats_private.reject_auth_metadata_update()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$ BEGIN
  RAISE EXCEPTION 'Auth metadata is read only' USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION mjstats_private.reject_auth_metadata_update()
  FROM PUBLIC, anon, authenticated, service_role, mjstats_api;
CREATE TRIGGER reject_auth_update INSTEAD OF UPDATE ON mjstats_private.auth_subjects
  FOR EACH ROW EXECUTE FUNCTION mjstats_private.reject_auth_metadata_update();
CREATE TRIGGER reject_auth_update INSTEAD OF UPDATE ON mjstats_private.auth_sessions
  FOR EACH ROW EXECUTE FUNCTION mjstats_private.reject_auth_metadata_update();

-- Retain the NOLOGIN/NOBYPASSRLS function owner and the original boolean API.
GRANT mjstats_auth_validator TO postgres;
CREATE OR REPLACE FUNCTION mjstats_private.valid_session(subject uuid, session uuid)
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
    INTO confirmed, banned, deleted FROM mjstats_private.auth_subjects AS u
    WHERE u.id = subject FOR SHARE;
  IF NOT FOUND OR confirmed IS NULL OR deleted IS NOT NULL
     OR (banned IS NOT NULL AND banned > clock_timestamp()) THEN
    RETURN false;
  END IF;
  SELECT s.user_id, s.not_after INTO session_owner, deadline
    FROM mjstats_private.auth_sessions AS s WHERE s.id = session FOR SHARE;
  RETURN FOUND AND session_owner = subject
    AND (deadline IS NULL OR deadline > clock_timestamp());
END;
$$;
REVOKE ALL ON FUNCTION mjstats_private.valid_session(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mjstats_private.valid_session(uuid, uuid) TO mjstats_api;
REVOKE mjstats_auth_validator FROM postgres;

-- Remove the now-unnecessary Auth column grants from the earlier migration.
REVOKE SELECT (id, email_confirmed_at, banned_until, deleted_at)
  ON auth.users FROM mjstats_auth_validator;
REVOKE SELECT (id, user_id, not_after)
  ON auth.sessions FROM mjstats_auth_validator;
COMMIT;
