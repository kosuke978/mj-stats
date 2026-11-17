import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const target = process.argv[2]
if (!['api', 'web-build', 'web-start'].includes(target))
  throw new Error('Use api / web-build / web-start')
const config = JSON.parse(
  readFileSync(resolve(root, '.local/managed-acceptance.json'), 'utf8'),
)
if (
  config.PROJECT_NAME !== 'mj-stats-step1-qa' ||
  config.PROJECT_REF === 'ijvoezfsyvchvgbfjlji' ||
  config.API_URL !== `https://${config.PROJECT_REF}.supabase.co`
)
  throw new Error('Unexpected managed QA project')
const web = target.startsWith('web')
const env = Object.fromEntries(
  readFileSync(
    resolve(root, '.local', web ? 'managed-web.env' : 'managed-api.env'),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line) => {
      const i = line.indexOf('=')
      return [line.slice(0, i), line.slice(i + 1)]
    }),
)
if (env[web ? 'NEXT_PUBLIC_SUPABASE_URL' : 'SUPABASE_URL'] !== config.API_URL)
  throw new Error('QA environment mismatch')
const args = web
  ? [
      'run',
      target === 'web-build' ? 'build' : 'start',
      ...(target === 'web-start' ? ['--', '--port', '3001'] : []),
    ]
  : ['run', '.']
const child = spawn(web ? 'npm' : 'go', args, {
  cwd: resolve(root, web ? 'web' : 'api'),
  env: { ...process.env, ...env, MJSTATS_QA_BUILD: '1' },
  stdio: 'inherit',
})
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => child.kill(signal))
child.on('exit', (code) => process.exit(code ?? 1))
