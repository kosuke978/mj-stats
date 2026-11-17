// Idempotent local ES256 key setup. It does not start/reset/link any database.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
if (!readFileSync('supabase/config.toml','utf8').includes('project_id = "mj-stats-step1"') || existsSync('supabase/.temp/project-ref')) throw new Error('Refusing unexpected or linked project')
mkdirSync('.local', { recursive: true, mode: 0o700 })
const file = 'supabase/signing_keys.json'
if (!existsSync(file)) {
  writeFileSync(file, '[]\n', { mode: 0o600 })
  try { execFileSync('node_modules/.bin/supabase', ['gen','signing-key','--algorithm','ES256','--append'], { stdio: 'ignore' }) }
  catch { throw new Error('Local signing-key generation failed; no key material was printed') }
}
const keys = JSON.parse(readFileSync(file,'utf8'))
if (!Array.isArray(keys) || keys.length === 0 || keys.some(key => key.alg !== 'ES256' || !key.d)) throw new Error('Expected local ES256 private signing keys')
chmodSync(file,0o600)
console.log('Local ES256 key ready (key material withheld).')
