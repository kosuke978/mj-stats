// Temporarily lower ONLY the identified local stack's OTP lifetime, then restore.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const container = 'supabase_db_mj-stats-step1'
const info = JSON.parse(
  execFileSync('docker', ['inspect', container], { encoding: 'utf8' }),
)[0]
if (
  info.Config.Labels['com.supabase.cli.project'] !== 'mj-stats-step1' ||
  existsSync('supabase/.temp/project-ref')
)
  throw new Error('Refusing unexpected/linked project')
const config = 'supabase/config.toml'
const original = readFileSync(config, 'utf8')
if (
  !original.includes('project_id = "mj-stats-step1"') ||
  !original.includes('otp_expiry = 3600')
)
  throw new Error('Expected normal local OTP configuration')
const temporary = original.replace('otp_expiry = 3600', 'otp_expiry = 2')
writeFileSync('.local/expiry-original-config.toml', original, { mode: 0o600 })
const cli = (...args) =>
  execFileSync('node_modules/.bin/supabase', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
  })
const start = async () => {
  cli('start')
  // The template server can become ready after Auth's first template fetch.
  // Reload Auth after the full stack is ready to avoid using fallback emails.
  execFileSync('docker', ['restart', 'supabase_auth_mj-stats-step1'], {
    stdio: 'ignore',
    timeout: 30_000,
  })
  const local = JSON.parse(readFileSync('.local/acceptance.json', 'utf8'))
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`${local.API_URL}/auth/v1/health`, {
        headers: { apikey: local.ANON_KEY },
      })
      if (response.ok) return
    } catch {
      /* local restart */
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Local Auth restart timed out')
}
let stage = 'local OTP configuration'
try {
  writeFileSync(config, temporary)
  console.log(
    'Using a 2-second OTP lifetime on mj-stats-step1 only; canonical configuration will be restored.',
  )
  cli('stop')
  await start()
  stage = 'timed mail acceptance'
  execFileSync(
    'npm',
    ['run', 'test:browser', '--', 'tests/browser/supabase-email.spec.ts'],
    {
      cwd: 'web',
      env: { ...process.env, MJSTATS_EMAIL_EXPIRY: '1' },
      stdio: 'inherit',
      timeout: 180_000,
    },
  )
} catch {
  console.error(
    `Timed Auth acceptance failed during ${stage}; CLI credential output withheld.`,
  )
  process.exitCode = 1
} finally {
  const current = readFileSync(config, 'utf8')
  if (current !== temporary && current !== original) {
    console.error(
      'Configuration changed independently; it was preserved. Restore the normal OTP setting manually before further testing.',
    )
    process.exitCode = 1
  } else {
    writeFileSync(config, original)
    try {
      cli('stop')
      await start()
      console.log(
        'Restored the normal local OTP lifetime (3600 seconds), retaining DB data.',
      )
    } catch {
      console.error(
        'Normal configuration restored on disk; local stack restart failed.',
      )
      process.exitCode = 1
    }
  }
}
