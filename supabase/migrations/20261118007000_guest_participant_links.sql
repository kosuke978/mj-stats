-- Step 3: league-local guests and consent-based participant links.
BEGIN;

CREATE FUNCTION mjstats_private.active_league_actor(target_league uuid, actor uuid, manager boolean)
RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT target_league = NULLIF(current_setting('mjstats.league_id', true), '')::uuid
     AND actor = NULLIF(current_setting('mjstats.league_actor_id', true), '')::uuid
     AND EXISTS (SELECT 1 FROM public.league_members m JOIN public.users u ON u.id=m.user_id
       WHERE m.league_id=target_league AND m.user_id=actor AND m.status='active'
         AND m.participant_kind='registered' AND u.auth_id IS NOT NULL AND u.profile_completed_at IS NOT NULL
         AND (NOT manager OR m.role IN ('owner','admin')))
$$;
REVOKE ALL ON FUNCTION mjstats_private.active_league_actor(uuid, uuid, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mjstats_private.active_league_actor(uuid, uuid, boolean) TO mjstats_api;

CREATE POLICY api_guest_create ON public.users FOR INSERT TO mjstats_api WITH CHECK (
  participant_kind='guest' AND auth_id IS NULL AND profile_completed_at IS NULL
  AND mjstats_private.active_league_actor(
    NULLIF(current_setting('mjstats.league_id', true), '')::uuid,
    NULLIF(current_setting('mjstats.league_actor_id', true), '')::uuid, false)
);
ALTER POLICY api_members_create ON public.league_members WITH CHECK (
  status <> 'legacy' AND (participant_kind <> 'guest' OR (
    role='member' AND status='active' AND mjstats_private.active_league_actor(
      league_id, NULLIF(current_setting('mjstats.league_actor_id', true), '')::uuid, false)))
);

CREATE TABLE public.participant_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id uuid NOT NULL,
  guest_user_id uuid NOT NULL,
  registered_user_id uuid NOT NULL,
  guest_kind varchar(10) GENERATED ALWAYS AS ('guest'::varchar) STORED,
  registered_kind varchar(10) GENERATED ALWAYS AS ('registered'::varchar) STORED,
  status text NOT NULL DEFAULT 'pending',
  consented_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid,
  reviewed_at timestamptz,
  confirmation_note text,
  version bigint NOT NULL DEFAULT 1,
  FOREIGN KEY (league_id, guest_user_id) REFERENCES public.league_members(league_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, registered_user_id) REFERENCES public.league_members(league_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, reviewed_by) REFERENCES public.league_members(league_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (guest_user_id, guest_kind) REFERENCES public.users(id, participant_kind) ON DELETE RESTRICT,
  FOREIGN KEY (registered_user_id, registered_kind) REFERENCES public.users(id, participant_kind) ON DELETE RESTRICT,
  CHECK ((status='pending' AND version=1 AND reviewed_by IS NULL AND reviewed_at IS NULL AND confirmation_note IS NULL)
      OR (status IN ('active','rejected') AND version=2 AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
          AND confirmation_note IS NOT NULL AND char_length(confirmation_note) BETWEEN 1 AND 500))
);
CREATE UNIQUE INDEX participant_links_active_guest ON public.participant_links(guest_user_id) WHERE status='active';
CREATE UNIQUE INDEX participant_links_pending_pair ON public.participant_links(guest_user_id,registered_user_id) WHERE status='pending';
CREATE INDEX participant_links_league_page ON public.participant_links(league_id,consented_at DESC,id DESC);
CREATE INDEX participant_links_league_registered ON public.participant_links(league_id,registered_user_id);
ALTER TABLE public.participant_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.participant_links FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.participant_links TO mjstats_api;
GRANT INSERT (league_id,guest_user_id,registered_user_id) ON public.participant_links TO mjstats_api;
GRANT UPDATE (status,reviewed_by,reviewed_at,confirmation_note,version) ON public.participant_links TO mjstats_api;
CREATE POLICY api_links_read ON public.participant_links FOR SELECT TO mjstats_api
  USING (league_id = NULLIF(current_setting('mjstats.league_id', true), '')::uuid);
CREATE POLICY api_links_request ON public.participant_links FOR INSERT TO mjstats_api
  WITH CHECK (mjstats_private.active_league_actor(league_id,registered_user_id,false));
CREATE POLICY api_links_review ON public.participant_links FOR UPDATE TO mjstats_api
  USING (status='pending' AND mjstats_private.active_league_actor(
    league_id,NULLIF(current_setting('mjstats.league_actor_id',true),'')::uuid,true))
  WITH CHECK (status IN ('active','rejected') AND mjstats_private.active_league_actor(league_id,reviewed_by,true));

GRANT SELECT (target) ON public.league_events TO mjstats_api;
CREATE POLICY api_guest_event_read ON public.league_events FOR SELECT TO mjstats_api USING (
  operation IN ('guest.create','participant-link.request','participant-link.approve','participant-link.reject')
  AND actor_id=NULLIF(current_setting('mjstats.league_actor_id',true),'')::uuid);
CREATE POLICY api_guest_event_append ON public.league_events FOR INSERT TO mjstats_api WITH CHECK (
  operation IN ('guest.create','participant-link.request','participant-link.approve','participant-link.reject')
  AND mjstats_private.active_league_actor(league_id,actor_id,operation IN ('participant-link.approve','participant-link.reject')));

COMMIT;
