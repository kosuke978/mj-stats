-- Step 5: additional operation records and consent to owner transfer.
BEGIN;

ALTER TABLE public.league_events
  ADD COLUMN before jsonb CHECK (before IS NULL OR jsonb_typeof(before)='object'),
  ADD COLUMN reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500);
CREATE INDEX league_events_page ON public.league_events(league_id,created_at DESC,id DESC);
GRANT SELECT ON public.league_events TO mjstats_api;
GRANT INSERT (before,reason) ON public.league_events TO mjstats_api;

CREATE POLICY api_management_event_read ON public.league_events FOR SELECT TO mjstats_api
  USING (mjstats_private.current_league_actor(league_id,true) OR (
    actor_id=NULLIF(current_setting('mjstats.league_actor_id',true),'')::uuid
    AND operation IN ('member.role','member.remove','member.leave','owner-transfer.propose',
      'owner-transfer.accept','owner-transfer.cancel','league.settings','rule.create','rule.available',
      'season.create','season.update','guest.rename','participant-link.revoke')));
CREATE POLICY api_management_event_append ON public.league_events FOR INSERT TO mjstats_api
  WITH CHECK (actor_id=NULLIF(current_setting('mjstats.league_actor_id',true),'')::uuid
    AND league_id=NULLIF(current_setting('mjstats.league_id',true),'')::uuid
    AND (
      (operation IN ('member.role','member.remove','owner-transfer.propose','owner-transfer.accept',
        'owner-transfer.cancel','league.settings','rule.create','rule.available','season.create',
        'season.update','guest.rename','participant-link.revoke')
        AND mjstats_private.current_league_actor(league_id,true))
      OR (operation='member.leave' AND target=actor_id AND EXISTS (
        SELECT 1 FROM public.league_members m WHERE m.league_id=league_events.league_id
          AND m.user_id=actor_id AND m.participant_kind='registered' AND m.status='left'))
    ));

CREATE TABLE public.owner_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE RESTRICT,
  from_user_id uuid NOT NULL,
  to_user_id uuid NOT NULL,
  from_version bigint NOT NULL CHECK (from_version>0),
  to_version bigint NOT NULL CHECK (to_version>0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','cancelled','expired')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  acted_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  FOREIGN KEY (league_id,from_user_id) REFERENCES public.league_members(league_id,user_id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id,to_user_id) REFERENCES public.league_members(league_id,user_id) ON DELETE RESTRICT,
  CHECK (from_user_id<>to_user_id AND expires_at>created_at),
  CHECK ((status='pending' AND acted_at IS NULL AND version=1) OR
         (status<>'pending' AND acted_at IS NOT NULL AND version=2))
);
CREATE UNIQUE INDEX owner_transfers_pending ON public.owner_transfers(league_id) WHERE status='pending';
ALTER TABLE public.owner_transfers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.owner_transfers FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.owner_transfers TO mjstats_api;
GRANT INSERT (league_id,from_user_id,to_user_id,from_version,to_version,expires_at) ON public.owner_transfers TO mjstats_api;
GRANT UPDATE (status,acted_at,version) ON public.owner_transfers TO mjstats_api;

CREATE POLICY api_transfer_read ON public.owner_transfers FOR SELECT TO mjstats_api USING (
  mjstats_private.current_league_actor(league_id,true) OR
  mjstats_private.active_league_actor(league_id,to_user_id,false));
CREATE POLICY api_transfer_create ON public.owner_transfers FOR INSERT TO mjstats_api WITH CHECK (
  mjstats_private.active_league_actor(league_id,from_user_id,true)
  AND EXISTS (SELECT 1 FROM public.leagues l WHERE l.id=league_id AND l.owner_id=from_user_id));
CREATE POLICY api_transfer_update ON public.owner_transfers FOR UPDATE TO mjstats_api
  USING (status='pending' AND (mjstats_private.active_league_actor(league_id,from_user_id,true)
    OR mjstats_private.active_league_actor(league_id,to_user_id,false)))
  WITH CHECK ((status='accepted' AND mjstats_private.active_league_actor(league_id,to_user_id,true))
    OR (status IN ('cancelled','expired') AND mjstats_private.current_league_actor(league_id,true)));

ALTER TABLE public.participant_links
  DROP CONSTRAINT participant_links_check,
  ADD COLUMN revoked_by uuid,
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoke_reason text,
  ADD FOREIGN KEY (league_id,revoked_by) REFERENCES public.league_members(league_id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT participant_links_state_check CHECK (
    (status='pending' AND version=1 AND reviewed_by IS NULL AND reviewed_at IS NULL AND confirmation_note IS NULL
      AND revoked_by IS NULL AND revoked_at IS NULL AND revoke_reason IS NULL)
    OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
      AND confirmation_note IS NOT NULL AND char_length(confirmation_note) BETWEEN 1 AND 500
      AND ((status IN ('active','rejected') AND version=2 AND revoked_by IS NULL AND revoked_at IS NULL AND revoke_reason IS NULL)
        OR (status='revoked' AND version=3 AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL
          AND revoke_reason IS NOT NULL AND char_length(revoke_reason) BETWEEN 1 AND 500)))
  );
GRANT UPDATE (revoked_by,revoked_at,revoke_reason) ON public.participant_links TO mjstats_api;
CREATE POLICY api_link_revoke ON public.participant_links FOR UPDATE TO mjstats_api
  USING (status='active' AND mjstats_private.current_league_actor(league_id,true)
    AND EXISTS (SELECT 1 FROM public.leagues l WHERE l.id=league_id
      AND l.owner_id=NULLIF(current_setting('mjstats.league_actor_id',true),'')::uuid))
  WITH CHECK (status='revoked' AND mjstats_private.active_league_actor(league_id,revoked_by,true)
    AND EXISTS (SELECT 1 FROM public.leagues l WHERE l.id=league_id AND l.owner_id=revoked_by));

CREATE POLICY api_guest_rename ON public.users FOR UPDATE TO mjstats_api
  USING (participant_kind='guest' AND EXISTS (SELECT 1 FROM public.league_members m
    WHERE m.user_id=users.id AND m.status='active' AND mjstats_private.current_league_actor(m.league_id,true)
    AND NOT EXISTS (SELECT 1 FROM public.participant_links p
      WHERE p.league_id=m.league_id AND p.guest_user_id=users.id AND p.status='active')))
  WITH CHECK (participant_kind='guest' AND auth_id IS NULL AND profile_completed_at IS NULL);

ALTER POLICY api_rules_update ON public.rules
  USING (calculation_version='exact_v1' AND mjstats_private.current_league_actor(league_id,true))
  WITH CHECK (calculation_version='exact_v1' AND mjstats_private.current_league_actor(league_id,true));
ALTER POLICY api_seasons_create ON public.seasons
  WITH CHECK (mjstats_private.current_league_actor(league_id,true));
GRANT UPDATE (name,start_date,end_date,version) ON public.seasons TO mjstats_api;
CREATE POLICY api_season_update ON public.seasons FOR UPDATE TO mjstats_api
  USING (mjstats_private.current_league_actor(league_id,true))
  WITH CHECK (mjstats_private.current_league_actor(league_id,true));

COMMIT;
