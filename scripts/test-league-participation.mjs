import { dbAssertions, fixtureID, leagueA, leagueB, ownerA, ownerB } from './test-rule-season-foundation.mjs'

export function testParticipation(sql, coreFingerprint) {
  const api = 'mjstats_api'
  const [active, nonexistent, request] = [91, 92, 93].map(fixtureID)
  const fingerprint = coreFingerprint + "SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.league_events e;"
  const { check, reject } = dbAssertions(sql, fingerprint)
  const scope = `SET LOCAL mjstats.league_actor_id='${ownerA}'; SET LOCAL mjstats.join_league_id='${leagueB}'`
  const admin = statement => sql(`BEGIN; SET LOCAL ROLE ${api}; ${statement}; COMMIT;`, 'supabase_admin')
  const count = "SELECT attempts FROM mjstats_private.count_attempt(ARRAY[repeat('c',64)])"
  const lookup = `SELECT * FROM mjstats_private.join_invite('${leagueB}','${ownerA}',NULL)`
  const event = (id, actor = ownerA) => `
    INSERT INTO public.league_events(league_id,actor_id,operation,client_request_id,target,version,request_hash,after,join_invite_id)
    VALUES ('${leagueB}','${actor}','league.join','${request}','${actor}',1,repeat('a',64),'{}', '${id}')`
  sql(`DELETE FROM public.league_invites WHERE league_id='${leagueB}';
    INSERT INTO public.league_invites(id,league_id,issued_by,issued_at,expires_at,key_version,credential_hash)
    VALUES ('${active}','${leagueB}','${ownerA}',now(),now()+interval '168 hours',1,repeat('c',64));`)
  reject('join event must scope actor', `${scope}; ${event(active, ownerB)}`, '42501', api)
  reject('join invite must exist in relevant league', `${scope}; ${event(nonexistent)}`, '23503', api)
  reject('invite join must scope league', `SET LOCAL mjstats.league_actor_id='${ownerA}'; ${event(active)}`, '42501', api)
  reject('another league invitation cannot be linked', `${scope}; ${event(fixtureID(83))}`, '23503', api)
  admin(`${scope}; ${event(active)}`)
  check('member has no direct invitation view', 'NOT EXISTS (SELECT FROM public.league_invites)', api)
  check('own invite replay needs actor scope', `NOT EXISTS (SELECT FROM mjstats_private.join_invite('${leagueB}','${ownerA}','${request}'))`, api)
  check('app role uses limited invite projection', `EXISTS (SELECT FROM mjstats_private.join_invite('${leagueB}','${ownerA}',NULL))`, api)
  reject('counter no direct read', 'SELECT * FROM public.api_rate_limits', '42501', api)
  for (const role of ['anon', 'authenticated', 'service_role']) {
    reject('public invite lookup denied', lookup, '42501', role)
    reject('public counter call denied', count, '42501', role)
    reject('public counter pruning denied', 'SELECT mjstats_private.prune_attempts()', '42501', role)
  }
  const counts = admin(`${count}; ${count}`).split('\n').slice(-3,-1)
  if (counts.join(',') !== '1,2') throw new Error('counter increments not shared')
  sql("INSERT INTO public.api_rate_limits VALUES (repeat('d',64),clock_timestamp()-interval '121 seconds',1)")
  admin("SELECT mjstats_private.prune_attempts()")
  check('only expired counter pruned', "count(*)=1 AND sum(attempts)=2 FROM public.api_rate_limits")
  console.log('PASS Q-25 participation: invite digest only, join scope and FK, atomic shared attempts and pruning, no public access')
}
