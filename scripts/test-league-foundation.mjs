// DB acceptance only: these cases do not implement or certify league APIs.
import { spawn } from 'node:child_process'

export function testLeagueMigration(sql, body) {
  // Exercise unusual pre-migration rows in a transaction and discard only this
  // synthetic scenario. The actual snapshot remains unchanged.
  sql(`BEGIN;
    INSERT INTO public.users(id,name,participant_kind) VALUES
      ('e1000000-0000-0000-0000-000000000001','unlinked registered','registered'),
      ('e1000000-0000-0000-0000-000000000002','unknown participant','legacy');
    INSERT INTO public.leagues(id,name,owner_id) VALUES
      ('e2000000-0000-0000-0000-000000000001','legacy with unknown roles','e1000000-0000-0000-0000-000000000001'),
      ('e2000000-0000-0000-0000-000000000002','legacy owner without membership','e1000000-0000-0000-0000-000000000001');
    INSERT INTO public.league_members(league_id,user_id,role,joined_at) VALUES
      ('e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',NULL,NULL),
      ('e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000002','unknown_old_role',NULL);
    ${body.replace('BEGIN;', '').replace(/COMMIT;\s*$/, '')}
    DO $$ BEGIN
      IF (SELECT count(*) FROM public.league_members WHERE league_id='e2000000-0000-0000-0000-000000000001'
        AND status='legacy' AND ended_at IS NULL AND joined_at IS NULL) <> 2
        OR NOT EXISTS (SELECT 1 FROM public.league_members WHERE user_id='e1000000-0000-0000-0000-000000000001' AND participant_kind='registered' AND role IS NULL)
        OR NOT EXISTS (SELECT 1 FROM public.league_members WHERE user_id='e1000000-0000-0000-0000-000000000002' AND participant_kind='legacy' AND role='unknown_old_role')
        OR EXISTS (SELECT 1 FROM public.leagues WHERE group_number IS NOT NULL OR search_listed)
      THEN RAISE EXCEPTION 'Legacy classification changed'; END IF;
    END $$;
    SET CONSTRAINTS ALL IMMEDIATE;
    ROLLBACK;`)
  console.log('PASS pre-migration NULL/unknown role, NULL joined_at, owner without membership, unlinked registered kind preserved as legacy memberships')
}

export async function testLeagueFoundation(sql, { container, database }) {
  const id = n => `f0000000-0000-0000-0000-${String(n).padStart(12, '0')}`
  const u = [1, 2, 3, 4, 5].map(id), l = [11, 12, 13].map(id)
  const fingerprint = () => sql(`SELECT jsonb_build_object(${['users','leagues','league_members','seasons','rules','matches','match_results'].map(t => `'${t}',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.${t} t)`).join(',')})`)
  let cases = 0
  function check(label, condition) {
    if (sql(`SELECT (${condition});`) !== 't') throw new Error(label)
    cases++
  }
  function reject(label, statement, code, role = 'postgres') {
    const before = fingerprint()
    let error
    try { sql(`BEGIN; SET LOCAL ROLE ${role}; ${statement}; COMMIT;`, 'supabase_admin') } catch (e) { error = e }
    if (!error || !String(error.stderr).includes(code) || before !== fingerprint()) throw new Error(`${label}: expected ${code} and full rollback`)
    cases++
  }
  const asAPI = statement => sql(`SET ROLE mjstats_api; ${statement}`, 'supabase_admin')
  const member = (league, user, kind = 'registered', role = 'member', status = 'active', ended = 'NULL') =>
    `INSERT INTO public.league_members(league_id,user_id,participant_kind,role,status,ended_at) VALUES('${league}','${user}','${kind}',${role === null ? 'NULL' : `'${role}'`},'${status}',${ended})`
  const league = (league, owner, number) =>
    `INSERT INTO public.leagues(id,name,owner_id,group_number) VALUES('${league}','2-1 fixture','${owner}',${number === null ? 'NULL' : `'${number}'`})`
  sql(`INSERT INTO public.users(id,name,participant_kind) VALUES
    ('${u[0]}','owner A','registered'),('${u[1]}','owner B','registered'),('${u[2]}','member','registered'),
    ('${u[3]}','guest','guest'),('${u[4]}','unverified','legacy');
    BEGIN; ${league(l[0],u[0],'000000000001')}; ${member(l[0],u[0],'registered','owner')};
    ${league(l[1],u[1],'000000000002')}; ${member(l[1],u[1],'registered','owner')}; COMMIT;`)
  check('number and defaults', `EXISTS (SELECT 1 FROM public.leagues WHERE id='${l[0]}' AND group_number='000000000001' AND NOT search_listed AND version=1)`)
  asAPI(`BEGIN;
    WITH created AS (INSERT INTO public.leagues(name,owner_id,group_number)
      VALUES('API role creation','${u[0]}','000000000004') RETURNING id)
    INSERT INTO public.league_members(league_id,user_id,participant_kind,role,status)
      SELECT id,'${u[0]}','registered','owner','active' FROM created;
    COMMIT;`)
  check('API role atomic creation', `EXISTS(SELECT 1 FROM public.leagues l JOIN public.league_members m ON (m.league_id,m.user_id)=(l.id,l.owner_id) WHERE l.group_number='000000000004' AND m.status='active' AND m.role='owner')`)
  asAPI(`${member(l[0],u[2])}; ${member(l[1],u[2])}; ${member(l[0],u[3],'guest')};`)
  check('normal membership', `(SELECT count(*) FROM public.league_members WHERE user_id='${u[2]}' AND status='active' AND ended_at IS NULL AND version=1)=2`)
  reject('duplicate membership', member(l[0],u[2]), '23505', 'mjstats_api')
  for (const role of [null,'superadmin']) reject('invalid role', member(l[1],u[3],'guest',role), '23514')
  reject('kind mismatch', member(l[1],u[3],'registered'), '23503')
  reject('unknown participant', member(l[0],id(999)), '23503')
  reject('unknown league', member(id(999),u[2]), '23503')
  reject('legacy participant active', member(l[0],u[4],'legacy'), '23514')
  reject('guest admin', `UPDATE public.league_members SET role='admin' WHERE user_id='${u[3]}'`, '23514')
  reject('guest second league', member(l[1],u[3],'guest'), '23505')
  asAPI(`UPDATE public.league_members SET status='left',ended_at=now(),version=version+1 WHERE user_id='${u[3]}';`)
  reject('ended guest second league', member(l[1],u[3],'guest'), '23505')
  reject('kind rewrite breaks references', `UPDATE public.users SET participant_kind='registered' WHERE id='${u[3]}'`, '23503')
  for (const statement of [
    `UPDATE public.league_members SET status='invalid' WHERE user_id='${u[2]}'`,
    `UPDATE public.league_members SET status='removed' WHERE user_id='${u[2]}'`,
    `UPDATE public.league_members SET ended_at=now() WHERE user_id='${u[2]}'`,
    `UPDATE public.league_members SET version=0 WHERE user_id='${u[2]}'`,
    `UPDATE public.leagues SET version=0 WHERE id='${l[0]}'`,
  ]) reject('state/version check', statement, '23514')
  asAPI(`UPDATE public.league_members SET status='removed',ended_at=now(),version=version+1 WHERE league_id='${l[0]}' AND user_id='${u[2]}';
    UPDATE public.league_members SET status='active',ended_at=NULL,role='member',version=version+1 WHERE league_id='${l[0]}' AND user_id='${u[2]}';`)
  check('rejoin preserves PK', `(SELECT count(*) FROM public.league_members WHERE league_id='${l[0]}' AND user_id='${u[2]}' AND status='active' AND version=3)=1`)
  reject('duplicate group number', league(l[2],u[0],'000000000001'), '23505')
  for (const number of ['123','12345678901x']) reject('invalid group number', league(l[2],u[0],number), '23514')
  reject('normal owner required', `INSERT INTO public.leagues(name,group_number) VALUES('missing owner','000000000003')`, '23514')
  reject('owner membership required at commit', league(l[2],u[0],'000000000003'), '23514')
  reject('owner mismatch', `${league(l[2],u[0],'000000000003')}; ${member(l[2],u[1],'registered','owner')}`, '23514')
  reject('two active owners', member(l[0],u[1],'registered','owner'), '23505')
  reject('owner reference alone', `UPDATE public.leagues SET owner_id='${u[2]}' WHERE id='${l[0]}'`, '23514', 'mjstats_api')
  for (const statement of [
    `UPDATE public.league_members SET role='member' WHERE league_id='${l[0]}' AND user_id='${u[0]}'`,
    `UPDATE public.league_members SET status='left',ended_at=now() WHERE league_id='${l[0]}' AND user_id='${u[0]}'`,
    `DELETE FROM public.league_members WHERE league_id='${l[0]}' AND user_id='${u[0]}'`,
  ]) reject('owner membership cannot disappear', statement, '23514')
  reject('owner membership cannot move into another owner', `UPDATE public.league_members SET league_id='${l[1]}' WHERE league_id='${l[0]}' AND user_id='${u[0]}'`, '23505')
  // A complete transfer is allowed at the DB layer; consent/API/audit follow later.
  asAPI(`BEGIN;
    UPDATE public.league_members SET role='admin' WHERE league_id='${l[0]}' AND user_id='${u[0]}';
    UPDATE public.league_members SET role='owner' WHERE league_id='${l[0]}' AND user_id='${u[2]}';
    UPDATE public.leagues SET owner_id='${u[2]}',version=version+1 WHERE id='${l[0]}'; COMMIT;`)
  check('consistent owner transfer', `EXISTS(SELECT 1 FROM public.leagues l JOIN public.league_members m ON (m.league_id,m.user_id)=(l.id,l.owner_id) WHERE l.id='${l[0]}' AND m.role='owner' AND m.status='active')`)
  sql(`BEGIN; ${league(l[2],u[0],null)}; COMMIT;`)
  reject('legacy league listing', `UPDATE public.leagues SET search_listed=true WHERE id='${l[2]}'`, '23514')
  reject('legacy league normal membership', member(l[2],u[0],'registered','owner'), '23514')
  // RLS must not expose legacy rows or allow ordinary writes to create them.
  check('legacy invisible to API', `NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mjstats_api' AND (rolsuper OR rolbypassrls))`)
  if (asAPI(`SELECT count(*) FROM public.leagues WHERE group_number IS NULL;`) !== 'SET\n0') throw new Error('Legacy league visible')
  if (asAPI(`SELECT count(*) FROM public.league_members WHERE status='legacy';`) !== 'SET\n0') throw new Error('Legacy membership visible')
  reject('API legacy league creation', `INSERT INTO public.leagues(name,owner_id) VALUES('legacy','${u[0]}')`, '42501','mjstats_api')
  reject('API legacy membership creation', member(l[1],u[4],'legacy','member','legacy'), '42501','mjstats_api')
  reject('API status downgrade to legacy', `UPDATE public.league_members SET status='legacy' WHERE league_id='${l[0]}' AND user_id='${u[0]}'`, '42501','mjstats_api')
  for (const statement of [
    `DELETE FROM public.leagues WHERE false`, `DELETE FROM public.league_members WHERE false`,
    `UPDATE public.leagues SET group_number=group_number WHERE false`,
    `UPDATE public.league_members SET user_id=user_id WHERE false`,
    `UPDATE public.league_members SET participant_kind=participant_kind WHERE false`,
    `SELECT * FROM auth.users`, `SELECT * FROM mjstats_private.auth_subjects`,
    `SELECT mjstats_private.check_league_owner()`,
  ]) reject('API forbidden privilege', statement, '42501','mjstats_api')
  for (const role of ['anon','authenticated']) for (const table of ['leagues','league_members']) {
    for (const statement of [`SELECT * FROM public.${table}`,`INSERT INTO public.${table} DEFAULT VALUES`,`DELETE FROM public.${table} WHERE false`,`UPDATE public.${table} SET version=version WHERE false`]) reject('public role denied',statement,'42501',role)
  }
  for (const role of ['anon','authenticated','service_role']) reject('public constraint function denied', `SELECT mjstats_private.check_league_owner()`, '42501',role)
  // Test each former CASCADE path independently; a different FK must not mask it.
  reject('owner user delete restricted', `DELETE FROM public.users WHERE id='${u[0]}'`, '23503')
  sql(`INSERT INTO public.users(id,name) VALUES('${id(6)}','legacy owner only'); INSERT INTO public.leagues(name,owner_id) VALUES('owner reference only','${id(6)}');`)
  reject('owner-only user delete restricted', `DELETE FROM public.users WHERE id='${id(6)}'`, '23503')
  reject('member user delete restricted', `DELETE FROM public.users WHERE id='${u[3]}'`, '23503')
  reject('league with members delete restricted', `DELETE FROM public.leagues WHERE id='${l[0]}'`, '23503')
  sql(`INSERT INTO public.seasons(league_id,name) VALUES('${l[2]}','preserved season');`)
  reject('league with season delete restricted', `DELETE FROM public.leagues WHERE id='${l[2]}'`, '23503')
  sql(`DELETE FROM public.seasons WHERE league_id='${l[2]}'; INSERT INTO public.rules(league_id,name,uma_1,uma_2,uma_3,uma_4) VALUES('${l[2]}','preserved rule',20,10,-10,-20);`)
  reject('league with rule delete restricted', `DELETE FROM public.leagues WHERE id='${l[2]}'`, '23503')
  console.log(`PASS ${cases} league DB assertions: constraints, lifecycle, deferred owner/rollback, legacy isolation, RESTRICT and role boundaries`)

  // One transaction holds the league. A concurrent attempt to remove its owner
  // must wait (pg_locks evidence), then fail at COMMIT and preserve the owner.
  const launch = input => {
    const child = spawn('docker',['exec','-i',container,'psql','-X','-A','-t','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1'])
    let stdout='',stderr=''
    child.stdout.on('data',b => { stdout += b }); child.stderr.on('data',b => { stderr += b })
    const done = new Promise((resolve,reject) => { child.on('error',reject); child.on('close',code => resolve({code,stdout,stderr})) })
    child.stdin.write(input)
    return { child, done }
  }
  const held = launch(`BEGIN; SELECT id FROM public.leagues WHERE id='${l[0]}' FOR UPDATE;\n`)
  let other
  try {
    const waitFor = async query => {
      const deadline=Date.now()+8000
      while (Date.now()<deadline) {
        if (sql(query)==='t') return
        await new Promise(r=>setTimeout(r,40))
      }
      throw new Error('Concurrent lock not observed')
    }
    await waitFor(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction');`)
    other=launch(`BEGIN; SET LOCAL application_name='step2-owner-removal'; UPDATE public.league_members SET status='removed',ended_at=now() WHERE league_id='${l[0]}' AND user_id='${u[2]}'; COMMIT;\n`)
    other.child.stdin.end()
    await waitFor(`SELECT EXISTS(SELECT 1 FROM pg_locks k JOIN pg_stat_activity a ON a.pid=k.pid WHERE a.datname=current_database() AND a.application_name='step2-owner-removal' AND NOT k.granted);`)
    held.child.stdin.end('COMMIT;\n')
    const [a,b]=await Promise.all([held.done,other.done])
    if(a.code!==0 || b.code===0 || !b.stderr.includes('League requires its active registered owner membership')) throw new Error('Concurrent owner invariant failed')
    check('owner preserved after concurrent rollback', `EXISTS(SELECT 1 FROM public.league_members WHERE league_id='${l[0]}' AND user_id='${u[2]}' AND status='active' AND role='owner')`)
    console.log('PASS concurrent owner change: lock wait observed, invalid commit rejected, owner preserved')
  } finally {
    if (!held.child.stdin.destroyed) held.child.stdin.end('ROLLBACK;\n')
    if (other && !other.child.stdin.destroyed) other.child.stdin.end('ROLLBACK;\n')
    await held.done
    if(other) await other.done
  }
}
