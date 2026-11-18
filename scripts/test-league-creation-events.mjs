import { dbAssertions, fixtureID, leagueA, leagueB, ownerA, ownerB } from './test-rule-season-foundation.mjs'

export const eventTableShape = (table) => `
  SELECT jsonb_build_object(
    'columns', (SELECT jsonb_agg(to_jsonb(c) ORDER BY ordinal_position) FROM information_schema.columns c
      WHERE table_schema='public' AND table_name='${table}'),
    'constraints', (SELECT jsonb_agg(pg_get_constraintdef(oid) ORDER BY conname)
      FROM pg_constraint WHERE conrelid='public.${table}'::regclass),
    'indexes', (SELECT jsonb_agg(to_jsonb(i) ORDER BY indexname) FROM pg_indexes i
      WHERE schemaname='public' AND tablename='${table}'),
    'policies', (SELECT jsonb_agg(to_jsonb(p) ORDER BY policyname)
      FROM pg_policies p WHERE schemaname='public' AND tablename='${table}'),
    'grants', (SELECT jsonb_agg(to_jsonb(g) ORDER BY grantee,column_name,privilege_type)
      FROM information_schema.column_privileges g WHERE table_schema='public' AND table_name='${table}'),
    'rls', (SELECT relrowsecurity FROM pg_class WHERE oid='public.${table}'::regclass)
  );`

export function testLeagueCreationEvents(sql, fingerprint) {
  const { check, reject } = dbAssertions(sql, fingerprint)
  const api = 'mjstats_api'
  const requestID = fixtureID(70)
  const ruleA = "(SELECT id FROM public.rules WHERE league_id='" + leagueA + "' AND name='2-2 rule')"
  const append = (actor = ownerA, league = leagueA, operation = 'league.create') => `
    INSERT INTO public.league_events(league_id,actor_id,operation,client_request_id,target,version,request_hash,after)
    VALUES ('${league}','${actor}','${operation}','${requestID}','${league}',1,
      repeat('a',64),jsonb_build_object('initial_rule_id',${ruleA}))`
  const scope = actor => `SET LOCAL mjstats.league_actor_id='${actor}'`
  reject('event without scope', append(), '42501', api)
  reject('append for another actor', `${scope(ownerB)}; ${append()}`, '42501', api)
  reject('other operations closed', `${scope(ownerA)}; ${append(ownerA, leagueA, 'league.invite')}`, '42501', api)
  reject('other league rule FK', `${scope(ownerA)}; ${append(ownerA, leagueB)}`, '23503', api)
  const visible = sql(`BEGIN; SET LOCAL ROLE ${api}; ${scope(ownerA)}; ${append()};
    SELECT count(initial_rule_id) FROM public.league_events; COMMIT;`, 'supabase_admin')
  if (visible.split('\n').at(-2) !== '1') throw new Error('Creation event read/append scope')
  check('event scope cannot outlive transaction', 'NOT EXISTS (SELECT league_id FROM public.league_events)', api)
  reject('duplicate creation identity', `${scope(ownerA)}; ${append()}`, '23505', api)
  reject('event payload not exposed', 'SELECT after FROM public.league_events', '42501', api)
  reject('creation event immutable', 'UPDATE public.league_events SET after=NULL', '42501', api)
  reject('creation event cannot be deleted', 'DELETE FROM public.league_events', '42501', api)
  for (const role of ['anon', 'authenticated', 'service_role']) {
    reject('event private from public roles', 'SELECT * FROM public.league_events', '42501', role)
    reject('public append denied', append(), '42501', role)
  }
  console.log('PASS Q-25 creation events: actor-scoped append/read, stable rule FK, uniqueness, no modification or public access')
}
