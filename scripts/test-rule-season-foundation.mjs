// Fixtures and SQL assertions used only in test-migrations' disposable DB.
export const fixtureID = n => `a2200000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const leagueA = fixtureID(11), leagueB = fixtureID(12)
export const ownerA = fixtureID(1), ownerB = fixtureID(2)

export const normalLeagues = `
  INSERT INTO public.users(id,name,participant_kind) VALUES
    ('${ownerA}','2-2 owner A','registered'), ('${ownerB}','2-2 owner B','registered');
  INSERT INTO public.leagues(id,name,owner_id,group_number) VALUES
    ('${leagueA}','2-2 league A','${ownerA}','022000000001'),
    ('${leagueB}','2-2 league B','${ownerB}','022000000002');
  INSERT INTO public.league_members(league_id,user_id,participant_kind,role,status) VALUES
    ('${leagueA}','${ownerA}','registered','owner','active'),
    ('${leagueB}','${ownerB}','registered','owner','active');
`

export function dbAssertions(sql, fingerprint) {
  function check(label, condition, role = 'postgres') {
    const result = sql(`SET ROLE ${role}; SELECT ${condition};`, 'supabase_admin')
    if (result !== 'SET\nt') throw new Error(label)
  }
  function reject(label, statement, code, role = 'postgres') {
    const before = sql(fingerprint)
    let sqlstate
    try {
      sql(`BEGIN; SET LOCAL ROLE ${role}; ${statement}; COMMIT;`, 'supabase_admin')
    } catch (error) {
      sqlstate = String(error.stderr).match(/ERROR:\s+([A-Z0-9]{5})/)?.[1]
    }
    if (sqlstate !== code || before !== sql(fingerprint)) {
      throw new Error(`${label}: expected ${code} with unchanged rows, got ${sqlstate ?? 'no SQLSTATE'}`)
    }
  }
  return { check, reject }
}

export function testRuleSeasonFoundation(sql, fingerprint) {
  const { check, reject } = dbAssertions(sql, fingerprint)
  const api = 'mjstats_api'
  const legacyRule = fixtureID(20)
  const insertRule = (overrides = {}) => {
    const row = {
      league_id: `'${leagueA}'`, name: "'2-2 rule'", default_points: 25000, return_points: 30000,
      uma_1: 20, uma_2: 10, uma_3: -10, uma_4: -20,
      calculation_version: "'exact_v1'", available: true, ...overrides,
    }
    return `INSERT INTO public.rules(${Object.keys(row).join(',')}) VALUES (${Object.values(row).join(',')})`
  }

  check('legacy rule classification', "NOT EXISTS (SELECT 1 FROM public.rules WHERE calculation_version <> 'legacy_unverified' OR available OR version <> 1)")
  sql(`BEGIN; ${normalLeagues}
    INSERT INTO public.rules(id,league_id,name,default_points,return_points,uma_1,uma_2,uma_3,uma_4)
      VALUES ('${legacyRule}','${leagueA}','2-2 legacy rule',NULL,NULL,3,6,-2,4);
    COMMIT;`)
  sql(`SET ROLE ${api}; ${insertRule()}; ${insertRule({ name: "'new edition'", uma_1: 30, uma_4: -30 })};`, 'supabase_admin')
  check('two rule IDs; legacy invisible', "count(*) = 2 AND count(DISTINCT id) = 2 AND bool_and(version = 1 AND available) FROM public.rules", api)
  for (const [label, overrides] of [
    ['S NULL', { default_points: 'NULL' }], ['R NULL', { return_points: 'NULL' }],
    ['S zero', { default_points: 0 }], ['S negative', { default_points: -100 }],
    ['S unit', { default_points: 25001 }], ['R unit', { return_points: 30001 }],
    ['R below S', { return_points: 24900 }], ['uma order', { uma_1: 10, uma_2: 20 }],
    ['uma sum', { uma_4: -21 }], ['big uma sum', { uma_1: 2147483647, uma_2: 2147483647 }],
    ['exact requires league', { league_id: 'NULL' }], ['unknown version', { calculation_version: "'unknown'" }],
    ['legacy unavailable', { calculation_version: "'legacy_unverified'" }],
  ]) reject(label, insertRule(overrides), '23514')
  reject('unknown league FK', insertRule({ league_id: `'${fixtureID(99)}'` }), '23503')
  reject('normal role cannot create legacy rule', insertRule({ calculation_version: "'legacy_unverified'", available: false }), '42501', api)
  reject('normal rule must start available', insertRule({ available: false }), '42501', api)
  for (const update of [
    "SET default_points=26000 WHERE name='2-2 rule'",
    "SET uma_1=50 WHERE name='2-2 rule'",
    "SET calculation_version='exact_v1' WHERE name='2-2 legacy rule'",
    `SET return_points=32000 WHERE id='${legacyRule}'`,
    `SET league_id='${leagueB}' WHERE name='2-2 rule'`,
  ]) reject('rule definition immutable to Go', `UPDATE public.rules ${update}`, '42501', api)
  reject('rule version positive', "UPDATE public.rules SET version=0 WHERE name='2-2 rule'", '23514', api)
  sql(`SET ROLE ${api}; UPDATE public.rules SET available=false,version=version+1 WHERE name='2-2 rule';`, 'supabase_admin')
  check('retired version still readable', "EXISTS (SELECT 1 FROM public.rules WHERE name='2-2 rule' AND NOT available AND version=2)", api)

  sql(`SET ROLE ${api}; INSERT INTO public.seasons(league_id,name,start_date,end_date) VALUES
    ('${leagueA}','2-2 November','2026-11-01','2026-11-30'),
    ('${leagueA}','2-2 open start',NULL,'2026-11-30'),
    ('${leagueA}','2-2 open end','2026-11-01',NULL),
    ('${leagueB}','2-2 unbounded',NULL,NULL);`, 'supabase_admin')
  check('UUID, positive version and open dates', "count(*) = 4 AND bool_and(pg_typeof(id) = 'uuid'::regtype AND version=1) AND count(*) FILTER (WHERE start_date IS NULL OR end_date IS NULL) = 3 FROM public.seasons", api)
  reject('reversed dates', `INSERT INTO public.seasons(league_id,name,start_date,end_date) VALUES ('${leagueA}','reversed','2026-12-01','2026-11-30')`, '23514', api)
  reject('season without league', "INSERT INTO public.seasons(name) VALUES ('no league')", '42501', api)
  reject('Go cannot alter season period', 'UPDATE public.seasons SET start_date=NULL', '42501', api)
  for (const table of ['rules', 'seasons']) {
    reject('Go cannot delete', `DELETE FROM public.${table} WHERE false`, '42501', api)
    for (const role of ['anon', 'authenticated']) {
      for (const statement of [`SELECT id FROM public.${table}`, `INSERT INTO public.${table} DEFAULT VALUES`,
        `UPDATE public.${table} SET version=version`, `DELETE FROM public.${table}`]) {
        reject('public role denied', statement, '42501', role)
      }
    }
  }
  console.log('PASS Q-16/Q-25 rules and seasons: versions, immutable conditions, retirement, UUID/open dates, reversed period rejection and role boundaries')
}
