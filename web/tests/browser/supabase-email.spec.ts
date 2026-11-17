import { test, expect, type APIRequestContext } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const local = JSON.parse(readFileSync('../.local/acceptance.json', 'utf8'))
test.skip(
  process.env.MJSTATS_EMAIL_EXPIRY !== '1',
  'Run via npm run test:auth-expiry on the dedicated local stack',
)
if (local.API_URL !== 'http://127.0.0.1:55421')
  throw new Error('Dedicated local Auth required')
const password = 'Expiry-Test-Password-123!'
async function auth(path: string, body: object, admin = false) {
  return fetch(`${local.API_URL}/auth/v1${path}`, {
    method: 'POST',
    headers: {
      apikey: local.ANON_KEY,
      'Content-Type': 'application/json',
      ...(admin ? { Authorization: `Bearer ${local.SERVICE_ROLE_KEY}` } : {}),
    },
    body: JSON.stringify(body),
  })
}
async function message(email: string, subject: string, except = '') {
  for (let i = 0; i < 60; i++) {
    const search = await fetch(
      `${local.MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
    ).then((r) => r.json())
    const found = search.messages?.find(
      (m: { ID: string; Subject: string }) =>
        m.ID !== except && m.Subject.includes(subject),
    )
    if (found) {
      const full = await fetch(
        `${local.MAILPIT_URL}/api/v1/message/${found.ID}`,
      ).then((r) => r.json())
      const href = (full.HTML as string)
        .match(/href="([^"]+)"/)?.[1]
        ?.replaceAll('&amp;', '&')
      if (href)
        return {
          id: found.ID as string,
          url: new URL(href, 'http://localhost:3000'),
        }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Expected local email not received')
}
async function expired(hash: string, type: string) {
  await new Promise((resolve) => setTimeout(resolve, 3100))
  const result = await auth('/verify', { token_hash: hash, type })
  const data = await result.json()
  expect(result.ok).toBeFalsy()
  expect(data.error_code ?? data.code).toBe('otp_expired')
}
async function confirm(request: APIRequestContext, url: URL) {
  try {
    return await request.get(url.toString())
  } catch {
    throw new Error('Confirmation request failed; credential URL withheld')
  }
}

async function passwordRequest(request: APIRequestContext, password: string) {
  try {
    return await request.post('/auth/password', {
      headers: { Origin: 'http://localhost:3000' },
      data: { password },
    })
  } catch {
    throw new Error('Password request failed; credential headers withheld')
  }
}

test('Q-21: expired confirmation/recovery, resend, Auth outage and password retry', async ({
  request,
}) => {
  test.setTimeout(150_000)
  const returnURL = 'http://localhost:3000/auth/confirm?returnTo=%2Faccount'
  const email = `expiry-${Date.now()}@example.test`
  const signup = await auth(
    `/signup?redirect_to=${encodeURIComponent(returnURL)}`,
    { email, password },
  )
  expect(signup.ok).toBeTruthy()
  const first = await message(email, '登録')
  await expired(first.url.searchParams.get('token_hash')!, 'email')
  const invalid = await confirm(request, first.url)
  expect(new URL(invalid.url()).pathname).toBe('/auth/error')
  const resend = await auth(
    `/resend?redirect_to=${encodeURIComponent(returnURL)}`,
    { type: 'signup', email },
  )
  expect(resend.ok).toBeTruthy()
  const resent = await message(email, '登録', first.id)
  expect(resent.id !== first.id).toBeTruthy()
  const confirmed = await confirm(request, resent.url)
  expect(new URL(confirmed.url()).pathname).toBe('/profile/setup')
  const login = await auth('/token?grant_type=password', { email, password })
  expect(login.ok).toBeTruthy()
  const session = await login.json()
  const me = await fetch('http://localhost:8080/api/users/me', {
    headers: { Authorization: `Bearer ${session.access_token}` },
  }).then((r) => r.json())
  const id = me.id
  expect(typeof id).toBe('string')

  expect(
    (
      await auth(`/recover?redirect_to=${encodeURIComponent(returnURL)}`, {
        email,
      })
    ).ok,
  ).toBeTruthy()
  const recovery = await message(email, '再設定')
  await expired(recovery.url.searchParams.get('token_hash')!, 'recovery')
  expect(new URL((await confirm(request, recovery.url)).url()).pathname).toBe(
    '/auth/error',
  )
  const blocked = await passwordRequest(request, 'Unverified-Expiry-456!')
  expect(blocked.status()).toBe(401)
  expect(
    (await auth('/token?grant_type=password', { email, password })).ok,
  ).toBeTruthy()
  expect(
    (
      await auth('/token?grant_type=password', {
        email,
        password: 'Unverified-Expiry-456!',
      })
    ).ok,
  ).toBeFalsy()

  expect(
    (
      await auth(`/recover?redirect_to=${encodeURIComponent(returnURL)}`, {
        email,
      })
    ).ok,
  ).toBeTruthy()
  const secondRecovery = await message(email, '再設定', recovery.id)
  expect(
    new URL((await confirm(request, secondRecovery.url)).url()).pathname,
  ).toBe('/password/update')
  const weak = await passwordRequest(request, 'short')
  expect(weak.status()).toBe(400)
  try {
    execFileSync('docker', ['stop', 'supabase_auth_mj-stats-step1'], {
      stdio: 'ignore',
      timeout: 30_000,
    })
    const failed = await passwordRequest(request, 'Recovered-Expiry-789!')
    expect(failed.status()).toBe(503)
  } finally {
    execFileSync('docker', ['start', 'supabase_auth_mj-stats-step1'], {
      stdio: 'ignore',
      timeout: 30_000,
    })
  }
  await expect
    .poll(async () => {
      try {
        return (
          await fetch(`${local.API_URL}/auth/v1/health`, {
            headers: { apikey: local.ANON_KEY },
          })
        ).status
      } catch {
        return 0
      }
    })
    .toBe(200)
  const success = await passwordRequest(request, 'Recovered-Expiry-789!')
  expect(success.status()).toBe(200)
  const previousSession = await fetch('http://localhost:8080/api/users/me', {
    headers: { Authorization: `Bearer ${session.access_token}` },
  })
  expect(previousSession.status).toBe(401)
  const previousRefresh = await auth('/token?grant_type=refresh_token', {
    refresh_token: session.refresh_token,
  })
  expect(previousRefresh.ok).toBeFalsy()
  const updated = await auth('/token?grant_type=password', {
    email,
    password: 'Recovered-Expiry-789!',
  })
  expect(updated.ok).toBeTruthy()
  const current = await updated.json()
  const same = await fetch('http://localhost:8080/api/users/me', {
    headers: { Authorization: `Bearer ${current.access_token}` },
  }).then((r) => r.json())
  expect(same.id === id).toBeTruthy()
  expect(
    (await auth('/token?grant_type=password', { email, password })).ok,
  ).toBeFalsy()
  console.log(
    'Q-21 PASS: real elapsed expiry for signup/recovery, received resend, failed update retains proof, Auth outage=503, retry succeeds with same participant; previous session=401 and refresh rejected',
  )
})
