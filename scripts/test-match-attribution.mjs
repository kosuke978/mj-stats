import { dbAssertions, fixtureID, leagueA, leagueB, ownerA, ownerB } from './test-rule-season-foundation.mjs'

export function testMatchAttribution(sql, fingerprint) {
  const { check, reject } = dbAssertions(sql, fingerprint)
  const api = 'mjstats_api'
  const matchA = fixtureID(51), matchNoSeason = fixtureID(52), matchB = fixtureID(53)
  const legacyMatch = fixtureID(54), legacyRule = fixtureID(20)
  const ruleB = fixtureID(61)
  const ruleA = "(SELECT id FROM public.rules WHERE name='2-2 rule')"
  const seasonA = "(SELECT id FROM public.seasons WHERE name='2-2 November')"
  const seasonB = "(SELECT id FROM public.seasons WHERE name='2-2 unbounded')"
  const instant = "'2026-11-01 00:00:00+09'"
  const match = (overrides = {}) => {
    const row = {
      id: `'${fixtureID(59)}'`, league_id: `'${leagueA}'`, rule_id: ruleA, season_id: seasonA,
      recorded_by: `'${ownerA}'`, match_date: instant, data_origin: "'app'", ...overrides,
    }
    return `INSERT INTO public.matches(${Object.keys(row).join(',')}) VALUES (${Object.values(row).join(',')})`
  }
  const result = (league, parent, user) =>
    `INSERT INTO public.match_results(league_id,match_id,user_id,raw_score,final_point,rank)
      VALUES (${league},${parent},${user},-100,-16.7,4)`
  const quote = value => `'${value}'`
  const appResult = (parent, user, league = leagueA) => result(quote(league), quote(parent), quote(user))

  check('existing matches remain legacy with unknown league/time',
    "NOT EXISTS (SELECT 1 FROM public.matches WHERE league_id IS NOT NULL OR match_date IS NOT NULL OR data_origin<>'legacy')")
  check('existing results remain legacy',
    "NOT EXISTS (SELECT 1 FROM public.match_results WHERE league_id IS NOT NULL OR data_origin<>'legacy')")

  sql(`BEGIN;
    INSERT INTO public.rules(id,league_id,name,uma_1,uma_2,uma_3,uma_4,calculation_version,available)
      VALUES ('${ruleB}','${leagueB}','2-2 league B rule',20,10,-10,-20,'exact_v1',true);
    ${match({ id: quote(matchA) })};
    ${match({ id: quote(matchNoSeason), season_id: 'NULL' })};
    ${match({ id: quote(matchB), league_id: quote(leagueB), rule_id: quote(ruleB), season_id: seasonB, recorded_by: quote(ownerB) })};
    INSERT INTO public.matches(id,rule_id,season_id) VALUES ('${legacyMatch}','${legacyRule}',${seasonA});
    ${appResult(matchA, ownerA)};
    ${appResult(matchNoSeason, ownerA)};
    COMMIT;`)
  check('explicit season and same UTC instant',
    `EXISTS (SELECT 1 FROM public.matches WHERE id='${matchA}' AND season_id=${seasonA}
      AND match_date='2026-10-31 15:00:00Z' AND (match_date AT TIME ZONE 'Asia/Tokyo')::date='2026-11-01'::date)`)
  check('no date-based automatic season',
    `EXISTS (SELECT 1 FROM public.matches WHERE id='${matchNoSeason}' AND season_id IS NULL AND match_date=${instant})`)
  check('rule reference retained on retired version',
    `EXISTS (SELECT 1 FROM public.matches m JOIN public.rules r ON r.id=m.rule_id
      WHERE m.id='${matchA}' AND NOT r.available AND r.version=2)`)
  check('same-league results preserve numeric type and value',
    `count(*)=2 AND bool_and(data_origin='app' AND league_id='${leagueA}' AND final_point=-16.7)
      FROM public.match_results WHERE match_id IN ('${matchA}','${matchNoSeason}')`)

  for (const overrides of [
    { league_id: 'NULL' }, { rule_id: 'NULL' }, { recorded_by: 'NULL' }, { match_date: 'NULL' },
    { data_origin: "'legacy'" }, { data_origin: "'unknown'" },
  ]) reject('origin/required references', match(overrides), '23514')
  reject('mixed rule league', match({ rule_id: quote(ruleB) }), '23503')
  reject('mixed season league', match({ season_id: seasonB }), '23503')
  reject('recorder must belong to same league', match({ recorded_by: quote(ownerB) }), '23503')
  reject('result in wrong league', appResult(matchB, ownerA), '23503')
  reject('result membership in wrong league', appResult(matchA, ownerB), '23503')
  reject('attributed result cannot attach to legacy match', appResult(legacyMatch, ownerA), '23503')
  reject('NULL league cannot bypass app result check', `INSERT INTO public.match_results(match_id,user_id,raw_score,final_point,rank)
      VALUES ('${matchB}','${ownerB}',-100,-16.7,4)`, '23503')
  reject('attributed result requires match and user', result(quote(leagueA), 'NULL', quote(ownerA)), '23514')
  reject('attributed result requires match and user', result(quote(leagueA), quote(matchA), 'NULL'), '23514')
  reject('same player cannot duplicate results', appResult(matchA, ownerA), '23505')
  reject('whole match and first result rollback on mismatched membership',
    `${match({})}; ${appResult(fixtureID(59), ownerA)}; ${appResult(fixtureID(59), ownerB)}`, '23503')

  reject('used rule is retained', `DELETE FROM public.rules WHERE id IN (${ruleA},'${legacyRule}')`, '23503')
  reject('season delete preserves match', `DELETE FROM public.seasons WHERE id=${seasonA}`, '23503')
  reject('match delete preserves results', `DELETE FROM public.matches WHERE id='${matchA}'`, '23503')
  reject('membership delete preserves recording/results',
    `DELETE FROM public.league_members WHERE league_id='${leagueA}' AND user_id='${ownerA}'`, '23503')

  check('history SELECT requires transaction scope',
    'NOT EXISTS (SELECT 1 FROM public.matches) AND NOT EXISTS (SELECT 1 FROM public.match_results)', api)
  const scoped = sql(`BEGIN; SET LOCAL ROLE ${api}; SET LOCAL mjstats.league_id='${leagueA}';
    SELECT count(*)=2 AND bool_and(data_origin='app' AND league_id='${leagueA}') FROM public.matches;
    SELECT count(*)=2 AND bool_and(data_origin='app' AND league_id='${leagueA}') FROM public.match_results;
    COMMIT; SET ROLE ${api}; SELECT NOT EXISTS (SELECT 1 FROM public.matches) AND NOT EXISTS (SELECT 1 FROM public.match_results);`, 'supabase_admin')
  if (scoped !== 'BEGIN\nSET\nSET\nt\nt\nCOMMIT\nSET\nt') throw new Error('Scoped history RLS or transaction reset failed')
  reject('no attributed match INSERT grant', match({}), '42501', api)
  reject('no attributed result INSERT grant', appResult(matchB, ownerB, leagueB), '42501', api)
  reject('old match INSERT also revoked', `INSERT INTO public.matches(rule_id,season_id,created_at) VALUES ('${legacyRule}',NULL,now())`, '42501', api)
  reject('old result INSERT also revoked', `INSERT INTO public.match_results(match_id,user_id,raw_score,final_point,rank)
    VALUES ('${legacyMatch}','${ownerA}',-100,-16.7,4)`, '42501', api)
  for (const table of ['matches', 'match_results']) {
    reject('Go cannot rewrite or delete history', `UPDATE public.${table} SET league_id=NULL`, '42501', api)
    reject('Go cannot rewrite or delete history', `DELETE FROM public.${table} WHERE false`, '42501', api)
    for (const role of ['anon', 'authenticated']) {
      reject('public role cannot read history', `SELECT id FROM public.${table}`, '42501', role)
      reject('public role cannot write history', `INSERT INTO public.${table} DEFAULT VALUES`, '42501', role)
    }
  }
  console.log('PASS Q-16/Q-25 match attribution: UUID/NULL season, UTC/JST, compound refs, rollback, deletion protection and staged privileges')
}
