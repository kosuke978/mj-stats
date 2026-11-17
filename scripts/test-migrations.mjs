// Synthetic legacy migration acceptance. Never connects to the shared database.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
const container = 'supabase_db_mj-stats-step1'
const info = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0]
if (info.Config.Labels['com.supabase.cli.project'] !== 'mj-stats-step1') throw new Error('Refusing unknown environment')
const database = `mjstats_migration_${Date.now()}`
function sql(text, user = 'postgres', db = database) {
  return execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-A', '-t', '-U', user, '-d', db, '-v', 'ON_ERROR_STOP=1'], { input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const beforeQuery = `SELECT jsonb_build_object(
'users',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.users t),
'leagues',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.leagues t),
'league_members',(SELECT jsonb_agg(to_jsonb(t) ORDER BY league_id,user_id) FROM public.league_members t),
'seasons',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.seasons t),
'rules',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.rules t),
'matches',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.matches t),
'match_results',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.match_results t));`
let created = false
try {
  sql(`CREATE DATABASE ${database} TEMPLATE template0;`, 'postgres', 'postgres'); created = true
  // Only the metadata contract is simulated here. Real Auth is tested separately.
  sql(`CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
    CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,not_after timestamptz);
    ALTER TABLE auth.users OWNER TO supabase_auth_admin; ALTER TABLE auth.sessions OWNER TO supabase_auth_admin;
    ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY; ALTER TABLE auth.sessions ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA auth TO postgres;
    GRANT SELECT ON auth.users,auth.sessions TO postgres WITH GRANT OPTION;
    GRANT REFERENCES ON auth.users TO postgres;`, 'supabase_admin')
  sql(readFileSync('supabase/migrations/20261117000000_baseline.sql','utf8'))
  const cols = sql(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public';`)
  const constraints = sql(`SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public';`)
  const indexes = sql(`SELECT count(*) FROM pg_indexes WHERE schemaname='public';`)
  if (cols !== '39' || constraints !== '20' || indexes !== '9') throw new Error('Baseline differs from documented schema')
  console.log('PASS baseline: 7 tables / 39 columns / 20 constraints / 9 indexes')
  sql(readFileSync('api/db/seed.sql','utf8'))
  sql(`UPDATE public.rules SET league_id=NULL;
    INSERT INTO public.rules(name,uma_1,uma_2,uma_3,uma_4) VALUES('Synthetic legacy alternate',20,10,-10,-20);
    WITH m AS (INSERT INTO public.matches(rule_id) SELECT '99999999-9999-9999-9999-999999999999'::uuid FROM generate_series(1,18) RETURNING id)
    INSERT INTO public.match_results(match_id,user_id,raw_score,final_point,rank)
    SELECT m.id,v.id::uuid,v.score,v.point,v.rank FROM m CROSS JOIN (VALUES
      ('11111111-1111-1111-1111-111111111111',40000,50,1),
      ('22222222-2222-2222-2222-222222222222',30000,10,2),
      ('33333333-3333-3333-3333-333333333333',20000,-20,3),
      ('44444444-4444-4444-4444-444444444444',10000,-40,4)) v(id,score,point,rank);`)
  const before = sql(beforeQuery)
  sql(readFileSync('supabase/migrations/20261117001000_auth_profile.sql','utf8'))
  sql(readFileSync('supabase/permissions/step1_auth.sql','utf8'), 'supabase_admin')
  const after = sql(beforeQuery.replace('jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.users', "jsonb_agg(to_jsonb(t)-'participant_kind'-'profile_completed_at'-'version' ORDER BY id) FROM public.users"))
  if (before !== after) throw new Error('Migration changed a legacy value or reference')
  const counts = sql(`SELECT (SELECT count(*) FROM public.users)||'/'||(SELECT count(*) FROM public.matches)||'/'||(SELECT count(*) FROM public.match_results)||'/'||(SELECT count(*) FROM public.users WHERE participant_kind='legacy' AND auth_id IS NULL AND profile_completed_at IS NULL);`)
  if (counts !== '5/19/76/5') throw new Error('Legacy preservation counts')
  let replayRejected = false
  try { sql(readFileSync('supabase/migrations/20261117001000_auth_profile.sql','utf8')) } catch { replayRejected = true }
  if (!replayRejected || after !== sql(beforeQuery.replace('jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.users', "jsonb_agg(to_jsonb(t)-'participant_kind'-'profile_completed_at'-'version' ORDER BY id) FROM public.users"))) throw new Error('Replay changed database')
  console.log('PASS synthetic increment: 5 participants / 19 matches / 76 results, every original value/reference preserved, all 5 classified legacy')
  console.log('PASS repeated raw migration rejected with no data change')
  console.log('NOT RUN: incremental migration of the actual shared-DB copy (developer stopped shared Supabase issue investigation)')
} catch {
  console.error('Migration test failed; SQL/connection details withheld')
  process.exitCode = 1
} finally {
  if (created) sql(`DROP DATABASE ${database} WITH (FORCE);`, 'postgres', 'postgres')
}
