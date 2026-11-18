-- Step 2 / 2-4: append-only operation records for retrying league creation.
BEGIN;

CREATE TABLE public.league_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  operation text NOT NULL,
  client_request_id uuid NOT NULL,
  target uuid NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  after jsonb NOT NULL CHECK (jsonb_typeof(after) = 'object'),
  initial_rule_id uuid GENERATED ALWAYS AS (
    CASE WHEN operation = 'league.create' THEN (after->>'initial_rule_id')::uuid END
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_id, operation, client_request_id),
  CONSTRAINT league_events_create_result_check
    CHECK (operation <> 'league.create' OR (target = league_id AND initial_rule_id IS NOT NULL)),
  CONSTRAINT league_events_initial_rule_fkey
    FOREIGN KEY (league_id, initial_rule_id) REFERENCES public.rules(league_id, id) ON DELETE RESTRICT
);
CREATE INDEX league_events_league_rule_idx ON public.league_events(league_id, initial_rule_id);
ALTER TABLE public.league_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.league_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT (league_id, actor_id, operation, client_request_id, request_hash, initial_rule_id)
  ON public.league_events TO mjstats_api;
GRANT INSERT (league_id, actor_id, operation, client_request_id, target, version, request_hash, after)
  ON public.league_events TO mjstats_api;

-- Service policy scopes access to the verified actor set by Go for this
-- transaction. This migration exposes no event API and grants no mutations
-- besides the one append operation needed by league creation.
CREATE POLICY api_league_creation_read ON public.league_events FOR SELECT TO mjstats_api
  USING (operation = 'league.create' AND
    actor_id = NULLIF(current_setting('mjstats.league_actor_id', true), '')::uuid);
CREATE POLICY api_league_creation_append ON public.league_events FOR INSERT TO mjstats_api
  WITH CHECK (operation = 'league.create' AND
    actor_id = NULLIF(current_setting('mjstats.league_actor_id', true), '')::uuid);

COMMIT;
