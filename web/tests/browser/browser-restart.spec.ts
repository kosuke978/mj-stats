import { test, expect, chromium } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const local = JSON.parse(readFileSync('../.local/acceptance.json', 'utf8'))
if (local.API_URL !== 'http://127.0.0.1:55421')
  throw new Error('Dedicated local Auth required')

test('Q-10: browser process restart restores its persisted session', async () => {
  const email = `restart-${Date.now()}@example.test`
  const password = 'Browser-Restart-Password-123!'
  const headers = { apikey: local.ANON_KEY, 'Content-Type': 'application/json' }
  const created = await fetch(`${local.API_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { ...headers, Authorization: `Bearer ${local.SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ email, password, email_confirm: true }),
  })
  expect(created.ok).toBeTruthy()
  const login = await fetch(
    `${local.API_URL}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, password }),
    },
  ).then((r) => r.json())
  const initial = await fetch('http://localhost:8080/api/users/me', {
    headers: { Authorization: `Bearer ${login.access_token}` },
  })
  expect(initial.status).toBe(200)
  const profile = await fetch('http://localhost:8080/api/users/me', {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${login.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: '再起動後の本人' }),
  })
  expect(profile.ok).toBeTruthy()
  const directory = mkdtempSync(resolve('../.local/browser-restart-'))
  let context = await chromium.launchPersistentContext(directory, {
    headless: true,
  })
  try {
    let page = await context.newPage()
    await page.goto('http://localhost:3000/login?returnTo=%2Faccount')
    await page.getByLabel('メールアドレス').fill(email)
    await page.getByLabel('パスワード', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'ログイン', exact: true }).click()
    await expect(page).toHaveURL('http://localhost:3000/account')
    await expect(page.getByLabel('表示名')).toHaveValue('再起動後の本人')
    await context.close()
    // A new Chromium process reads the actual on-disk browser profile.
    context = await chromium.launchPersistentContext(directory, {
      headless: true,
    })
    page = await context.newPage()
    await page.goto('http://localhost:3000/account')
    await expect(page).toHaveURL('http://localhost:3000/account')
    await expect(page.getByLabel('表示名')).toHaveValue('再起動後の本人')
    console.log(
      'Q-10 PASS: Chromium closed and relaunched with on-disk profile; account restored without password entry',
    )
  } finally {
    await context.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
