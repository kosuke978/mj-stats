// Local-only migration acceptance. --snapshot uses a READ ONLY remote export.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
const container = 'supabase_db_mj-stats-step1'
const info = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0]
if (info.Config.Labels['com.supabase.cli.project'] !== 'mj-stats-step1' || !info.NetworkSettings.Ports['5432/tcp'].some(p => p.HostPort === '55422')) throw new Error('Refusing unknown environment')
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--snapshot')) throw new Error('Use --snapshot <read-only-export.json>')
const input = args.length ? readFileSync(args[1], 'utf8') : null
const snapshot = input ? JSON.parse(input) : null
const tables = ['users', 'leagues', 'league_members', 'seasons', 'rules', 'matches', 'match_results']
const database = `mjstats_migration_${Date.now()}`
function sql(text, user = 'postgres', db = database) {
  return execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-A', '-t', '-U', user, '-d', db, '-v', 'ON_ERROR_STOP=1'], { input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const queries = {
  columns: `SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY table_name,ordinal_position),'[]') FROM (SELECT table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default,character_maximum_length,numeric_precision,numeric_scale FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('users','leagues','league_members','seasons','rules','matches','match_results')) c`,
  constraints: `SELECT jsonb_agg(to_jsonb(c) ORDER BY table_name,conname) FROM (SELECT t.relname table_name,c.conname,c.contype,pg_get_constraintdef(c.oid) definition,c.convalidated FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname IN ('users','leagues','league_members','seasons','rules','matches','match_results')) c`,
  rls: `SELECT jsonb_agg(to_jsonb(c) ORDER BY relname) FROM (SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('users','leagues','league_members','seasons','rules','matches','match_results')) c`,
  indexes: `SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY tablename,indexname),'[]') FROM (SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename IN ('users','leagues','league_members','seasons','rules','matches','match_results')) i`,
  policies: `SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname),'[]') FROM (SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' AND tablename IN ('users','leagues','league_members','seasons','rules','matches','match_results')) p`,
  triggers: `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY table_name,trigger_name),'[]') FROM (SELECT c.relname table_name,t.tgname trigger_name,pg_get_triggerdef(t.oid) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal AND c.relname IN ('users','leagues','league_members','seasons','rules','matches','match_results')) t`,
}
function sameJSON(a, b) {
  // jsonb equality ignores object key order and preserves numeric equality.
  const quote = value => "'" + JSON.stringify(value).replaceAll("'", "''") + "'::jsonb"
  return sql(`SELECT ${quote(a)} = ${quote(b)};`) === 't'
}
const beforeQuery = `SELECT jsonb_build_object(${tables.map(t => `'${t}',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.${t} t)`).join(',')});`
const afterQuery = `SELECT jsonb_build_object(${tables.map(t => `'${t}',(SELECT jsonb_agg(${t === 'users' ? "to_jsonb(t)-'participant_kind'-'profile_completed_at'-'version'" : 'to_jsonb(t)'} ORDER BY ${t === 'users' ? "(to_jsonb(t)-'participant_kind'-'profile_completed_at'-'version')::text" : 'to_jsonb(t)::text'}) FROM public.${t} t)`).join(',')});`
let created = false, stage = 'environment setup'
try {
  sql(`CREATE DATABASE ${database} TEMPLATE template0;`, 'postgres', 'postgres'); created = true
  // Auth metadata contract only; actual Auth and locking are tested separately.
  sql(`CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
    CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,not_after timestamptz);
    ALTER TABLE auth.users OWNER TO supabase_auth_admin; ALTER TABLE auth.sessions OWNER TO supabase_auth_admin;
    ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY; ALTER TABLE auth.sessions ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA auth TO postgres;
    GRANT SELECT ON auth.users,auth.sessions TO postgres WITH GRANT OPTION;
    GRANT UPDATE(id) ON auth.users,auth.sessions TO postgres;
    GRANT REFERENCES ON auth.users TO postgres;`, 'supabase_admin')
  stage = 'baseline application'
  sql(readFileSync('supabase/migrations/20261117000000_baseline.sql', 'utf8'))
  if (JSON.parse(sql(queries.columns)).length !== 39 || JSON.parse(sql(queries.constraints)).length !== 20 || JSON.parse(sql(queries.indexes)).length !== 9) throw new Error('Baseline shape')
  console.log('PASS baseline: 7 tables / 39 columns / 20 constraints / 9 indexes')
  stage = 'source schema comparison'
  if (snapshot) {
    for (const [name, query] of Object.entries(queries)) {
      if (!Array.isArray(snapshot[name]) || !sameJSON(snapshot[name], JSON.parse(sql(query)))) throw new Error(`Source ${name} differs`)
    }
    if (!tables.every(t => Array.isArray(snapshot[t])) || snapshot.users.some(u => u.auth_id !== null)) throw new Error('Unsupported snapshot/Auth references; do not infer identity')
    console.log(`PASS actual source schema: columns/constraints/indexes/RLS/policies/triggers match baseline; sha256=${createHash('sha256').update(input).digest('hex')}`)
    stage = 'source row import'
    for (const table of tables) {
      const json = JSON.stringify(snapshot[table]).replaceAll("'", "''")
      sql(`INSERT INTO public.${table} SELECT * FROM json_populate_recordset(NULL::public.${table}, '${json}'::json);`)
      if (Number(sql(`SELECT count(*) FROM public.${table};`)) !== snapshot[table].length) throw new Error('Row count')
    }
  } else {
    sql(readFileSync('api/db/seed.sql', 'utf8'))
    sql(`UPDATE public.rules SET league_id=NULL;
      INSERT INTO public.rules(name,uma_1,uma_2,uma_3,uma_4) VALUES('Synthetic legacy alternate',20,10,-10,-20);
      WITH m AS (INSERT INTO public.matches(rule_id) SELECT '99999999-9999-9999-9999-999999999999'::uuid FROM generate_series(1,18) RETURNING id)
      INSERT INTO public.match_results(match_id,user_id,raw_score,final_point,rank)
      SELECT m.id,v.id::uuid,v.score,v.point,v.rank FROM m CROSS JOIN (VALUES
        ('11111111-1111-1111-1111-111111111111',40000,50,1),('22222222-2222-2222-2222-222222222222',30000,10,2),
        ('33333333-3333-3333-3333-333333333333',20000,-20,3),('44444444-4444-4444-4444-444444444444',10000,-40,4)) v(id,score,point,rank);`)
  }
  const before = sql(beforeQuery)
  stage = 'incremental migrations'
  for (const file of readdirSync('supabase/migrations').filter(f => f.endsWith('.sql') && !f.includes('_baseline')).sort()) sql(readFileSync(`supabase/migrations/${file}`, 'utf8'))
  const after = sql(afterQuery)
  if (before !== after) throw new Error('Legacy value or reference changed')
  const counts = JSON.parse(sql(`SELECT json_build_object('users',(SELECT count(*) FROM public.users),'matches',(SELECT count(*) FROM public.matches),'results',(SELECT count(*) FROM public.match_results),'legacy',(SELECT count(*) FROM public.users WHERE participant_kind='legacy' AND auth_id IS NULL AND profile_completed_at IS NULL));`))
  const expectedUsers = snapshot ? snapshot.users.length : 5
  if (counts.users !== expectedUsers || counts.legacy !== expectedUsers || counts.matches !== (snapshot ? snapshot.matches.length : 19) || counts.results !== (snapshot ? snapshot.match_results.length : 76)) throw new Error('Legacy counts')
  if (sql(`SELECT NOT has_schema_privilege('mjstats_auth_validator','auth','USAGE') AND NOT has_any_column_privilege('mjstats_auth_validator','auth.users','SELECT,UPDATE');`) !== 't') throw new Error('Validator has direct Auth access')
  stage = 'replay rejection'
  let rejected = false
  try { sql(readFileSync('supabase/migrations/20261117001000_auth_profile.sql', 'utf8')) } catch { rejected = true }
  if (!rejected || after !== sql(afterQuery)) throw new Error('Replay changed rows')
  console.log(`PASS ${snapshot ? 'actual-copy' : 'synthetic'} increment: ${counts.users} participants / ${counts.matches} matches / ${counts.results} results; all old values and references preserved`)
  console.log('PASS normal postgres migrations; validator has no direct Auth access; repeated raw migration rejected without data change')
  if (!snapshot) console.log('Actual-copy acceptance is separate: rerun with --snapshot <read-only-export.json>.')
} catch {
  console.error(`Migration test failed during ${stage}; row values and connection details withheld`)
  process.exitCode = 1
} finally {
  if (created) sql(`DROP DATABASE ${database} WITH (FORCE);`, 'postgres', 'postgres')
}
