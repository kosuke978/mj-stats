// Only the explicitly identified, dedicated QA project is allowed here.
// Migration/config application remains a separately reviewable CLI step.
import { execFileSync } from 'node:child_process'
import { randomBytes, X509Certificate } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
process.chdir(root)
const ref = process.argv[2]
if (!/^[a-z]{20}$/.test(ref ?? '') || ref === 'ijvoezfsyvchvgbfjlji')
  throw new Error('An explicit dedicated QA ref is required')
const cli = (...args) => {
  const result = JSON.parse(
    execFileSync(
      'node_modules/.bin/supabase',
      [...args, '--output-format', 'json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
    ),
  )
  if (result._tag === 'Error' || result.error)
    throw new Error('QA CLI operation failed')
  return result
}
const save = (path, value) => {
  writeFileSync(path, value, { mode: 0o600 })
  chmodSync(path, 0o600)
}
let stage = 'dedicated project identity'
try {
  const projects = cli('projects', 'list').projects
  const project = projects.find((p) => (p.id ?? p.ref) === ref)
  if (
    project?.name !== 'mj-stats-step1-qa' ||
    project.status !== 'ACTIVE_HEALTHY'
  )
    throw new Error('Unexpected project')
  const linked = readFileSync(
    '.local/managed-project/supabase/.temp/project-ref',
    'utf8',
  ).trim()
  if (linked !== ref) throw new Error('Isolated link mismatch')
  const pooler = new URL(
    readFileSync(
      '.local/managed-project/supabase/.temp/pooler-url',
      'utf8',
    ).trim(),
  )
  if (
    !pooler.hostname.endsWith('.pooler.supabase.com') ||
    pooler.username !== `postgres.${ref}`
  )
    throw new Error('Unexpected pooler')
  stage = 'QA SSL CA certificate'
  const certificate = resolve('.local/supabase-ca.crt')
  if (!new X509Certificate(readFileSync(certificate)).ca)
    throw new Error('Expected downloaded CA certificate')
  stage = 'migration history'
  const history = cli(
    'db',
    'query',
    `--remote=${ref}`,
    '--read-only',
    'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version',
  ).rows
  if (
    JSON.stringify(history.map((r) => r.version)) !==
    JSON.stringify(['20261117000000', '20261117001000', '20261117002000'])
  )
    throw new Error('Unexpected migration history')
  stage = 'QA API role password'
  const password = randomBytes(32).toString('hex')
  save(
    '.local/managed-api-password.sql',
    `ALTER ROLE mjstats_api PASSWORD '${password}';`,
  )
  cli(
    'db',
    'query',
    `--remote=${ref}`,
    '--file',
    '.local/managed-api-password.sql',
    '--yes',
  )
  save(
    '.local/managed-api-password.sql',
    '-- Password applied; secret SQL removed.\n',
  )
  pooler.username = `mjstats_api.${ref}`
  pooler.password = password
  pooler.searchParams.set('sslmode', 'verify-full')
  pooler.searchParams.set('sslrootcert', certificate)
  pooler.searchParams.set('connect_timeout', '5')
  stage = 'QA Auth keys'
  const keys = cli('projects', 'api-keys', `--remote=${ref}`, '--reveal').keys
  const anon = keys.find((k) => k.name === 'anon')?.api_key
  const service = keys.find((k) => k.name === 'service_role')?.api_key
  if (!anon || !service) throw new Error('Expected QA keys unavailable')
  const url = `https://${ref}.supabase.co`
  save(
    '.local/managed-api.env',
    `DATABASE_URL=${pooler}\nSUPABASE_URL=${url}\nALLOWED_ORIGINS=http://localhost:3001\nPORT=8081\nGIN_MODE=release\n`,
  )
  save(
    '.local/managed-web.env',
    `NEXT_PUBLIC_API_URL=http://localhost:8081\nNEXT_PUBLIC_SUPABASE_URL=${url}\nNEXT_PUBLIC_SUPABASE_ANON_KEY=${anon}\nNEXT_PUBLIC_RULE_ID=99999999-9999-9999-9999-999999999999\nAPP_ORIGIN=http://localhost:3001\nAUTH_FLOW_SECRET=${randomBytes(32).toString('hex')}\n`,
  )
  save(
    '.local/managed-acceptance.json',
    JSON.stringify({
      PROJECT_REF: ref,
      PROJECT_NAME: project.name,
      API_URL: url,
      ANON_KEY: anon,
      SERVICE_ROLE_KEY: service,
      DB_URL: pooler.toString(),
    }),
  )
  console.log(
    'Prepared private .local/managed-{api,web}.env and managed-acceptance.json for mj-stats-step1-qa only. Shared .env files were preserved.',
  )
} catch {
  console.error(
    `Managed QA preparation failed during ${stage}; credentials and SQL withheld.`,
  )
  process.exitCode = 1
} finally {
  save('.local/managed-api-password.sql', '-- Password fixture removed.\n')
}
