// Writes only .local/ and sets a password on the identified local container.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
process.chdir(root)
const config = readFileSync('supabase/config.toml', 'utf8')
if (!config.includes('project_id = "mj-stats-step1"') || existsSync('supabase/.temp/project-ref')) throw new Error('Unexpected project')
const container = 'supabase_db_mj-stats-step1'
const info = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0]
if (info.Config.Labels['com.supabase.cli.project'] !== 'mj-stats-step1' || !info.NetworkSettings.Ports['5432/tcp'].some(p => p.HostPort === '55422')) throw new Error('Unexpected local DB')
const permissions = execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-A', '-t', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
  input: `SELECT to_regclass('mjstats_private.auth_subjects') IS NOT NULL
    AND NOT has_schema_privilege('mjstats_auth_validator','auth','USAGE')
    AND NOT has_table_privilege('mjstats_api','auth.users','SELECT')
    AND has_function_privilege('mjstats_api','mjstats_private.valid_session(uuid,uuid)','EXECUTE');`,
  encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
}).trim()
if (permissions !== 't') throw new Error('Apply the managed Auth validation migration to the dedicated local database; legacy Auth-owner permissions are unsupported')
const raw = execFileSync('node_modules/.bin/supabase', ['status', '-o', 'json', '--agent', 'no'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const status = JSON.parse(raw)
if (status.API_URL !== 'http://127.0.0.1:55421') throw new Error('Unexpected local Auth')
const adminURL = new URL(status.DB_URL)
adminURL.searchParams.set('sslmode', 'disable')
status.DB_URL = adminURL.toString()
mkdirSync('.local', { recursive: true, mode: 0o700 })
const password = randomBytes(32).toString('hex')
execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: `ALTER ROLE mjstats_api PASSWORD '${password}';\n`, stdio: ['pipe', 'ignore', 'pipe'] })
const api = `DATABASE_URL=postgresql://mjstats_api:${password}@127.0.0.1:55422/postgres?sslmode=disable\nSUPABASE_URL=${status.API_URL}\nALLOWED_ORIGINS=http://localhost:3000\nPORT=8080\n`
const web = `NEXT_PUBLIC_API_URL=http://localhost:8080\nNEXT_PUBLIC_SUPABASE_URL=${status.API_URL}\nNEXT_PUBLIC_SUPABASE_ANON_KEY=${status.ANON_KEY}\nAPP_ORIGIN=http://localhost:3000\nAUTH_FLOW_SECRET=${randomBytes(32).toString('hex')}\n`
writeFileSync('.local/api.env', api, { mode: 0o600 })
writeFileSync('.local/web.env', web, { mode: 0o600 })
writeFileSync('.local/acceptance.json', JSON.stringify(status), { mode: 0o600 })
console.log('Prepared .local/api.env, web.env and acceptance.json for mj-stats-step1 only. Existing api/.env and web/.env.local were preserved.')
