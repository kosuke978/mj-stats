-- Step 2 / 2-1 only. No league API, rule/season attribution or match conversion.
BEGIN;

ALTER TABLE public.users ADD CONSTRAINT users_id_kind_key UNIQUE (id, participant_kind);

ALTER TABLE public.leagues
  ADD COLUMN group_number char(12) UNIQUE,
  ADD COLUMN search_listed boolean NOT NULL DEFAULT false,
  ADD COLUMN version bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT leagues_group_number_check CHECK (group_number IS NULL OR group_number ~ '^[0-9]{12}$'),
  ADD CONSTRAINT leagues_normal_check CHECK (
    (group_number IS NULL AND NOT search_listed) OR (group_number IS NOT NULL AND owner_id IS NOT NULL)),
  ADD CONSTRAINT leagues_version_check CHECK (version > 0);
-- NULL group_number is the legacy boundary. Do not assign numbers or owners
-- to old leagues. The API role can only create numbered (normal) leagues.

ALTER TABLE public.league_members
  ADD COLUMN participant_kind varchar(10) NOT NULL DEFAULT 'legacy',
  ADD COLUMN status varchar(10) NOT NULL DEFAULT 'legacy',
  ADD COLUMN ended_at timestamptz,
  ADD COLUMN version bigint NOT NULL DEFAULT 1;
-- Copy only the already established participant kind; never derive it from
-- auth_id. In particular, unlinked registered participants stay registered.
UPDATE public.league_members m SET participant_kind = u.participant_kind
  FROM public.users u WHERE u.id = m.user_id;
ALTER TABLE public.league_members
  ADD CONSTRAINT league_members_user_kind_fkey FOREIGN KEY (user_id, participant_kind)
    REFERENCES public.users(id, participant_kind) ON DELETE RESTRICT,
  ADD CONSTRAINT league_members_status_check CHECK (status IN ('active', 'left', 'removed', 'legacy')),
  ADD CONSTRAINT league_members_normal_check CHECK (status = 'legacy' OR (
    participant_kind IN ('registered', 'guest') AND role IS NOT NULL AND role IN ('owner', 'admin', 'member')
    AND (participant_kind <> 'guest' OR role = 'member'))),
  ADD CONSTRAINT league_members_ended_check CHECK (
    (status IN ('active', 'legacy') AND ended_at IS NULL) OR
    (status IN ('left', 'removed') AND ended_at IS NOT NULL)),
  ADD CONSTRAINT league_members_version_check CHECK (version > 0);
-- Keep the original (league_id,user_id) PK, including ended memberships.
CREATE UNIQUE INDEX league_members_guest_user_key ON public.league_members(user_id)
  WHERE participant_kind = 'guest';
CREATE UNIQUE INDEX league_members_active_owner_key ON public.league_members(league_id)
  WHERE status = 'active' AND role = 'owner';

-- Protect participant/membership references and the league's history paths.
ALTER TABLE public.leagues DROP CONSTRAINT leagues_owner_id_fkey,
  ADD CONSTRAINT leagues_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE RESTRICT;
ALTER TABLE public.league_members DROP CONSTRAINT league_members_user_id_fkey,
  DROP CONSTRAINT league_members_league_id_fkey,
  ADD CONSTRAINT league_members_league_id_fkey FOREIGN KEY (league_id) REFERENCES public.leagues(id) ON DELETE RESTRICT;
ALTER TABLE public.seasons DROP CONSTRAINT seasons_league_id_fkey,
  ADD CONSTRAINT seasons_league_id_fkey FOREIGN KEY (league_id) REFERENCES public.leagues(id) ON DELETE RESTRICT;
ALTER TABLE public.rules DROP CONSTRAINT rules_league_id_fkey,
  ADD CONSTRAINT rules_league_id_fkey FOREIGN KEY (league_id) REFERENCES public.leagues(id) ON DELETE RESTRICT;

-- Check the final state, not the intermediate state during creation/transfer.
-- Lock the league and its owner membership so concurrent changes cannot commit
-- a check against a stale owner. Deadlock/serialization failures must roll back.
-- Owner rights make the invariant independent of the caller's RLS visibility.
CREATE FUNCTION mjstats_private.check_league_owner()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  target uuid;
  targets uuid[];
  league_owner uuid;
  numbered boolean;
BEGIN
  IF TG_TABLE_NAME = 'leagues' THEN
    IF TG_OP = 'DELETE' THEN targets := ARRAY[OLD.id];
    ELSIF TG_OP = 'INSERT' THEN targets := ARRAY[NEW.id];
    ELSE targets := ARRAY[OLD.id, NEW.id]; END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN targets := ARRAY[OLD.league_id];
    ELSIF TG_OP = 'INSERT' THEN targets := ARRAY[NEW.league_id];
    ELSE targets := ARRAY[OLD.league_id, NEW.league_id]; END IF;
  END IF;
  FOR target IN SELECT DISTINCT id FROM unnest(targets) AS t(id) ORDER BY id LOOP
    SELECT owner_id, group_number IS NOT NULL INTO league_owner, numbered
      FROM public.leagues WHERE id = target FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF numbered THEN
      PERFORM 1 FROM public.league_members
        WHERE league_id = target AND user_id = league_owner
          AND status = 'active' AND role = 'owner' AND participant_kind = 'registered'
        FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'League requires its active registered owner membership'
          USING ERRCODE = '23514', CONSTRAINT = 'league_owner_membership_check';
      END IF;
    ELSIF EXISTS (SELECT 1 FROM public.league_members WHERE league_id = target AND status <> 'legacy') THEN
      RAISE EXCEPTION 'Legacy league cannot have normal memberships'
        USING ERRCODE = '23514', CONSTRAINT = 'league_owner_membership_check';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
ALTER FUNCTION mjstats_private.check_league_owner() OWNER TO postgres;
REVOKE ALL ON FUNCTION mjstats_private.check_league_owner()
  FROM PUBLIC, anon, authenticated, service_role, mjstats_api, mjstats_auth_validator;
CREATE CONSTRAINT TRIGGER league_owner_membership_check
  AFTER INSERT OR UPDATE OR DELETE ON public.leagues
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mjstats_private.check_league_owner();
CREATE CONSTRAINT TRIGGER league_owner_membership_check
  AFTER INSERT OR UPDATE OR DELETE ON public.league_members
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mjstats_private.check_league_owner();

-- Service policies are not end-user authorization. Go authorization follows in
-- later Step 2 work. Legacy rows are not normal league candidates or writable
-- through this role. IDs/kinds/number/creation timestamps cannot be rewritten.
REVOKE ALL ON public.leagues, public.league_members FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.leagues, public.league_members TO mjstats_api;
GRANT INSERT (name, owner_id, group_number, search_listed) ON public.leagues TO mjstats_api;
GRANT UPDATE (name, owner_id, search_listed, version) ON public.leagues TO mjstats_api;
GRANT INSERT (league_id, user_id, participant_kind, role, status, ended_at) ON public.league_members TO mjstats_api;
GRANT UPDATE (role, status, ended_at, version) ON public.league_members TO mjstats_api;
CREATE POLICY api_leagues_read ON public.leagues FOR SELECT TO mjstats_api USING (group_number IS NOT NULL);
CREATE POLICY api_leagues_create ON public.leagues FOR INSERT TO mjstats_api WITH CHECK (group_number IS NOT NULL);
CREATE POLICY api_leagues_update ON public.leagues FOR UPDATE TO mjstats_api
  USING (group_number IS NOT NULL) WITH CHECK (group_number IS NOT NULL);
CREATE POLICY api_members_read ON public.league_members FOR SELECT TO mjstats_api USING (status <> 'legacy');
CREATE POLICY api_members_create ON public.league_members FOR INSERT TO mjstats_api WITH CHECK (status <> 'legacy');
CREATE POLICY api_members_update ON public.league_members FOR UPDATE TO mjstats_api
  USING (status <> 'legacy') WITH CHECK (status <> 'legacy');
COMMIT;
