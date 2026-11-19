import { dbAssertions, fixtureID, leagueA, leagueB, ownerA, ownerB } from './test-rule-season-foundation.mjs'

export function testExactMatches(sql, coreFingerprint) {
  const api = 'mjstats_api'
  const actor = fixtureID(201)
  const rule = fixtureID(202)
  const match = fixtureID(203)
  const operation = fixtureID(204)
  const guests = [205, 206, 207, 208].map(fixtureID)
  const scope = `SET LOCAL mjstats.league_actor_id='${ownerA}'; SET LOCAL mjstats.league_id='${leagueA}'`
  const fingerprint = coreFingerprint + `SELECT jsonb_agg(to_jsonb(v) ORDER BY match_id,version) FROM public.match_revisions v;`
  const { check, reject } = dbAssertions(sql, fingerprint)
  const asApi = statement => sql(`BEGIN; SET LOCAL ROLE ${api}; ${scope}; ${statement}; COMMIT;`, 'supabase_admin')

  sql(`SET ROLE supabase_auth_admin; INSERT INTO auth.users(id,email_confirmed_at) VALUES ('${actor}',now());`, 'supabase_admin')
  sql(`UPDATE public.users SET auth_id='${actor}',profile_completed_at=now() WHERE id='${ownerA}';
    INSERT INTO public.rules(id,league_id,name,uma_1,uma_2,uma_3,uma_4,calculation_version,available)
      VALUES ('${rule}','${leagueA}','exact fixture',20,10,-10,-20,'exact_v1',true);
    BEGIN;
    INSERT INTO public.users(id,name,participant_kind) VALUES ${guests.map(g => `('${g}','Step 3 guest','guest')`).join(',')};
    INSERT INTO public.league_members(league_id,user_id,participant_kind,role,status) VALUES
      ${guests.map(g => `('${leagueA}','${g}','guest','member','active')`).join(',')};
    COMMIT;`)

  const addMatch = (league = leagueA, recorder = ownerA) => `
    INSERT INTO public.matches(league_id,rule_id,recorded_by,match_date,data_origin,client_request_id,request_hash)
    VALUES ('${league}','${rule}','${recorder}','2024-11-01T00:00:00+09:00','app','${operation}',repeat('b',64))`
  const matchID = `(SELECT id FROM public.matches WHERE client_request_id='${operation}')`
  const addResults = (scores, numerators, denominators) => `
    INSERT INTO public.match_results(league_id,match_id,user_id,raw_score,rank,final_point_numerator,final_point_denominator)
    VALUES ${scores.map((score, i) =>
      `('${leagueA}',${matchID},'${guests[i]}',${score},${i === 3 ? 4 : 1},${numerators[i]},${denominators[i]})`).join(',')}`
  const addRevision = `INSERT INTO public.match_revisions
    (league_id,match_id,actor_id,operation,version,client_request_id,request_hash,after)
    VALUES ('${leagueA}',${matchID},'${ownerA}','create',1,'${operation}',repeat('b',64),'{}')`
  const scores = [33300, 33300, 33300, 100]
  const denominators = [30, 30, 30, 10]
  const points = [499, 499, 499, -499]

  reject('unscoped exact write', addMatch(), '42501', api)
  reject('wrong recorder', `${scope}; ${addMatch(leagueA, ownerB)}`, '42501', api)
  reject('wrong target league', `${scope}; ${addMatch(leagueB)}`, '42501', api)
  reject('legacy match insert stays closed',
    `${scope}; INSERT INTO public.matches(rule_id) VALUES ('${rule}')`, '42501', api)
  reject('legacy result insert stays closed',
    `${scope}; INSERT INTO public.match_results(match_id,user_id,raw_score,final_point,rank)
    VALUES ('${match}','${ownerA}',25000,0,1)`, '42501', api)
  reject('guest belongs to one league',
    `INSERT INTO public.league_members(league_id,user_id,participant_kind,role,status)
    VALUES ('${leagueB}','${guests[0]}','guest','member','active')`, '23505')

  reject('match without revision deferred to commit',
    `${scope}; ${addMatch()}; ${addResults(scores, points, denominators)}`, '23514', api)
  reject('only 3 results deferred to commit',
    `${scope}; ${addMatch()}; ${addResults(scores.slice(0,3), points, denominators)}; ${addRevision}`, '23514', api)
  reject('incorrect raw total deferred to commit',
    `${scope}; ${addMatch()}; ${addResults([33300,33300,33300,200], points, denominators)}; ${addRevision}`, '23514', api)
  reject('small nonzero rational total deferred to commit',
    `${scope}; ${addMatch()}; ${addResults(scores, [499,499,499,-499], [30,30,30,11])}; ${addRevision}`, '23514', api)
  reject('even exact sums require reduced values and positive denominator',
    `${scope}; ${addMatch()}; ${addResults(scores, [998,499,499,-499], [60,30,30,10])}`, '23514', api)
  reject('zero denominator refused',
    `${scope}; ${addMatch()}; ${addResults(scores, points, [0,30,30,10])}`, '23514', api)
  for (const role of ['anon', 'authenticated']) {
    reject('public cannot record', addMatch(), '42501', role)
    reject('public cannot read links', 'SELECT id FROM public.participant_links', '42501', role)
  }
  asApi(`${addMatch()}; ${addResults(scores, points, denominators)}; ${addRevision}`)
  check('exact fixture preserved',
    `count(*)=4 AND bool_and(final_point IS NULL) AND sum(raw_score)=100000 AND
      sum(final_point_numerator::numeric * (30/final_point_denominator))=0
      FROM public.match_results WHERE match_id=${matchID}`)
  reject('Go cannot overwrite exact point', 'UPDATE public.match_results SET final_point_numerator=0', '42501', api)
  reject('Go cannot mutate revision', 'DELETE FROM public.match_revisions', '42501', api)
  console.log('PASS Q-04/Q-05/Q-17/Q-25 scoped grants, one guest league, deferred count/scores/exact sum/revision, and independently verified commit')
}
