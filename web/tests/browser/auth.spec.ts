import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { createPrivateKey, sign } from 'node:crypto'

const local = JSON.parse(readFileSync('../.local/acceptance.json', 'utf8'))
if (local.API_URL !== 'http://127.0.0.1:55421')
  throw new Error('Only the isolated mj-stats-step1 environment is allowed')
const api = 'http://localhost:8080'
const password = 'QA-Only-Password-123!'

async function mailLink(email: string, subject: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const search = await fetch(
      `${local.MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
    ).then((r) => r.json())
    const message = search.messages?.find((m: { Subject: string }) =>
      m.Subject.includes(subject),
    )
    if (message) {
      const full = await fetch(
        `${local.MAILPIT_URL}/api/v1/message/${message.ID}`,
      ).then((r) => r.json())
      const href = (full.HTML as string)
        .match(/href="([^"]+)"/)?.[1]
        ?.replaceAll('&amp;', '&')
      if (href && href.startsWith('http://localhost:3000/auth/confirm?'))
        return href
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Local confirmation email was not delivered')
}
async function confirm(page: Page, href: string) {
  try {
    await page.goto(href)
  } catch {
    throw new Error('Confirmation navigation failed (credential URL withheld)')
  }
}
async function login(
  page: Page,
  email: string,
  pass = password,
  returnTo = '/account',
) {
  await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`)
  await page.getByLabel('メールアドレス').fill(email)
  await page.getByLabel('パスワード', { exact: true }).fill(pass)
  await page.getByRole('button', { name: 'ログイン', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(returnTo.replaceAll('/', '\\/')))
}
async function session(context: BrowserContext) {
  const cookies = await context.cookies('http://localhost:3000')
  const pieces = cookies
    .filter((c) => /sb-.*-auth-token(?:\.\d+)?$/.test(c.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  const raw = pieces.map((c) => c.value).join('')
  if (!raw.startsWith('base64-'))
    throw new Error('Expected Supabase SSR session cookie')
  return {
    value: JSON.parse(Buffer.from(raw.slice(7), 'base64url').toString()),
    cookies: pieces,
  }
}
async function expireAccessToken(
  context: BrowserContext,
  invalidRefresh = false,
) {
  const current = await session(context)
  const [header, payload] = current.value.access_token.split('.')
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
  claims.iat = Math.floor(Date.now() / 1000) - 3700
  claims.exp = Math.floor(Date.now() / 1000) - 100
  const data = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`
  const keys = JSON.parse(readFileSync('../supabase/signing_keys.json', 'utf8'))
  const key = createPrivateKey({ key: keys[0], format: 'jwk' })
  current.value.access_token = `${data}.${sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
  current.value.expires_at = claims.exp
  if (invalidRefresh) current.value.refresh_token = 'invalid-test-refresh-token'
  await context.clearCookies({ name: /^sb-.*-auth-token/ })
  // SDK normally chunks large sessions. These fixtures fit in one cookie.
  const source = current.cookies[0]
  const name = source.name.replace(/\.\d+$/, '')
  await context.addCookies([
    {
      ...source,
      name,
      value: `base64-${Buffer.from(JSON.stringify(current.value)).toString('base64url')}`,
    },
  ])
  return current.value.refresh_token as string
}

// One end-to-end flow, with real local Auth, mailbox, Go, database and SSR.
test('Q-09/Q-10/Q-21: registration, browser/SSR, refresh, recovery and local logout', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  })
  const page = await context.newPage()
  const email = `browser-${Date.now()}@example.test`
  await page.goto('/matches/new')
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fmatches%2Fnew/)
  await page.goto('/signup?returnTo=%2Fmatches%2Fnew')
  await page.getByLabel('メールアドレス').fill(email)
  await page.getByLabel('パスワード（8文字以上）').fill(password)
  await page
    .getByRole('button', { name: '登録して確認メールを受け取る' })
    .click()
  await expect(page.getByRole('status')).toContainText('確認メールをご確認')
  const link = await mailLink(email, '登録')
  await page.goto('/login')
  await page.getByLabel('メールアドレス').fill(email)
  await page
    .getByLabel('パスワード', { exact: true })
    .fill('Wrong-Password-000!')
  await page.getByRole('button', { name: 'ログイン', exact: true }).click()
  await expect(page.getByRole('status')).toContainText(
    'ログインできませんでした',
  )
  await page.getByLabel('パスワード', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'ログイン', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('メールの確認が必要')
  await confirm(page, link)
  await expect(page).toHaveURL(/\/profile\/setup/)
  await page.getByLabel('表示名', { exact: true }).fill('あ'.repeat(31))
  await page.getByRole('button', { name: '表示名を設定して進む' }).click()
  await expect(page.getByRole('status')).toContainText('1〜30文字')
  await page.getByLabel('表示名', { exact: true }).fill('　ブラウザ😀　')
  await page.getByRole('button', { name: '表示名を設定して進む' }).click()
  await expect(page).toHaveURL('/matches/new')
  await expect(page.getByText('ブラウザ😀', { exact: true })).toBeVisible()
  const first = await session(context)
  expect(
    first.cookies.every((c) => c.expires > Date.now() / 1000 + 86400),
  ).toBeTruthy()
  const beforeRedirect = await expireAccessToken(context)
  await page.goto('/login?returnTo=%2Faccount')
  await expect(page).toHaveURL('/account')
  expect(
    (await session(context)).value.refresh_token !== beforeRedirect,
  ).toBeTruthy()
  await page.goto('/matches/new')
  await expect(page.getByText('所属リーグの履歴から対局を入力できます。')).toBeVisible()
  await expect(page.getByRole('button', { name: '計算結果をプレビュー' })).toHaveCount(0)
  const stopped = await context.request.post(`${api}/api/matches/calculate`, {
    headers: { Authorization: `Bearer ${(await session(context)).value.access_token}` },
    data: { players: [] },
  })
  expect(stopped.status()).toBe(410)
  expect((await stopped.json()).error.code).toBe('API_RETIRED')
  await page.getByRole('link', { name: '所属リーグを選ぶ' }).click()
  await expect(page).toHaveURL('/matches')
  await expect(page.getByText('所属しているリーグがありません。')).toBeVisible()
  const ssr = await context.request.get('http://localhost:3000/matches')
  expect(ssr.status()).toBe(200)
  expect(ssr.headers()['cache-control']).toContain('no-store')
  expect(await ssr.text()).toContain('対局履歴')
  await page.reload()
  await expect(page.getByText('ブラウザ😀', { exact: true })).toBeVisible()
  // Expired access token + a real refresh token: refresh must write a new cookie.
  const oldRefresh = await expireAccessToken(context)
  await page.goto('/matches')
  await expect(page.getByRole('heading', { name: '対局履歴' })).toBeVisible()
  const refreshed = await session(context)
  expect(refreshed.value.refresh_token !== oldRefresh).toBeTruthy()
  expect(
    JSON.parse(
      Buffer.from(
        refreshed.value.access_token.split('.')[1],
        'base64url',
      ).toString(),
    ).exp >
      Date.now() / 1000,
  ).toBeTruthy()
  // Restoring persistent cookies into a new browser context simulates reopening.
  const state = await context.storageState()
  const restored = await browser.newContext({ storageState: state })
  const restoredPage = await restored.newPage()
  await restoredPage.goto('/account')
  await expect(restoredPage.getByLabel('表示名', { exact: true })).toHaveValue(
    'ブラウザ😀',
  )
  await restored.close()
  await page.goto('/account')
  await page.getByLabel('表示名', { exact: true }).fill('名前変更😀')
  await page.getByRole('button', { name: '表示名を変更', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('表示名を変更しました')
  // A forged or reused link cannot establish a recovery proof.
  await confirm(page, link)
  await expect(page).toHaveURL('/auth/error')
  await page.goto('/password/update')
  await expect(page).toHaveURL('/auth/error')
  const unverifiedUpdate = await context.request.post(
    'http://localhost:3000/auth/password',
    {
      headers: { Origin: 'http://localhost:3000' },
      data: { password: 'Unverified-Test-123!' },
    },
  )
  expect(unverifiedUpdate.status()).toBe(401)
  await page.goto('/password/reset')
  await page.getByLabel('メールアドレス').fill(email)
  await page.getByRole('button', { name: '再設定メールを依頼' }).click()
  await expect(page.getByRole('status')).toContainText('依頼を受け付けました')
  const recovery = await mailLink(email, '再設定')
  await confirm(page, recovery)
  await expect(page).toHaveURL('/password/update')
  await page
    .getByLabel('新しいパスワード（8文字以上）')
    .fill('QA-New-Password-456!')
  await page
    .getByRole('button', { name: 'パスワードを更新', exact: true })
    .click()
  await expect(page.getByRole('status')).toContainText(
    'パスワードを更新しました',
  )
  await page.getByRole('link', { name: 'MJ-Stats に戻る' }).click()
  await expect(page).toHaveURL('/matches')
  await page.goto('/account')
  await expect(page.getByLabel('表示名', { exact: true })).toHaveValue(
    '名前変更😀',
  )
  const afterRecovery = await session(context)
  expect(afterRecovery.value.user.id === first.value.user.id).toBeTruthy()
  const secondContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const second = await secondContext.newPage()
  await login(second, email, 'QA-New-Password-456!')
  const secondSession = await session(secondContext)
  const oldToken = afterRecovery.value.access_token
  const sibling = await context.newPage()
  await sibling.goto('/account')
  await page.getByRole('button', { name: 'このブラウザからログアウト' }).click()
  await expect(page).toHaveURL('/login')
  await expect(sibling).toHaveURL(/\/login/)
  await sibling.goto('/account')
  await expect(sibling).toHaveURL(/\/login/)
  const revoked = await fetch(`${api}/api/users/me`, {
    headers: { Authorization: `Bearer ${oldToken}` },
  })
  expect(revoked.status).toBe(401)
  await second.reload()
  await expect(second.getByLabel('表示名', { exact: true })).toHaveValue(
    '名前変更😀',
  )
  const alive = await fetch(`${api}/api/users/me`, {
    headers: { Authorization: `Bearer ${secondSession.value.access_token}` },
  })
  expect(alive.status).toBe(200)
  await second.screenshot({ path: test.info().outputPath('account-390.png') })
  await expireAccessToken(secondContext, true)
  await second.goto('/matches/new')
  await expect(second).toHaveURL(/\/login\?returnTo=%2Fmatches%2Fnew/)
  await secondContext.close()
  await context.close()
})

for (const width of [360, 390, 768, 1280]) {
  test(`Step 1 auth form: ${width}px, keyboard and 200% text`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/login')
    await page.getByLabel('メールアドレス').focus()
    await page.keyboard.press('Tab')
    await expect(page.getByLabel('パスワード', { exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(
      page.getByRole('button', { name: 'ログイン', exact: true }),
    ).toBeFocused()
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%'
    })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy()
    if (width === 360)
      await page.screenshot({ path: test.info().outputPath('login-360-text200.png') })
  })
}

test('Q-07/Q-10: CORS, invalid confirmation and unsafe return destinations', async ({
  page,
  request,
}) => {
  const preflight = await request.fetch(`${api}/api/matches`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:3000',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  })
  expect(preflight.status()).toBe(204)
  expect(
    preflight.headers()['access-control-allow-headers'].toLowerCase(),
  ).toContain('authorization')
  const denied = await request.fetch(`${api}/api/users/me`, {
    headers: { Origin: 'https://evil.invalid' },
  })
  expect(denied.headers()['access-control-allow-origin']).toBeUndefined()
  await page.goto(
    '/auth/confirm?type=invalid&token_hash=00000000000000000000000000000000&returnTo=https://evil.invalid',
  )
  await expect(page).toHaveURL('/auth/error')
  await page.goto('/login?returnTo=https://evil.invalid')
  expect(
    await page.getByRole('link', { name: '新規登録' }).getAttribute('href'),
  ).toBe('/signup?returnTo=%2Fmatches')
})

test('Q-10: changing accounts discards the previous viewer and SSR cache', async ({
  browser,
}) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const participants: string[] = []
  for (const label of ['利用者A', '利用者B']) {
    const email = `switch-${label.endsWith('A') ? 'a' : 'b'}-${Date.now()}@example.test`
    const created = await fetch(`${local.API_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: local.ANON_KEY,
        Authorization: `Bearer ${local.SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password, email_confirm: true }),
    })
    expect(created.status).toBe(200)
    await page.goto('/login?returnTo=%2Faccount')
    await page.getByLabel('メールアドレス').fill(email)
    await page.getByLabel('パスワード', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'ログイン', exact: true }).click()
    await expect(page).toHaveURL(/\/profile\/setup/)
    await page.getByLabel('表示名', { exact: true }).fill(label)
    await page.getByRole('button', { name: '表示名を設定して進む' }).click()
    await expect(page).toHaveURL('/account')
    await expect(page.getByLabel('表示名', { exact: true })).toHaveValue(label)
    const current = await session(context)
    const response = await fetch(`${api}/api/users/me`, {
      headers: { Authorization: `Bearer ${current.value.access_token}` },
    })
    const viewer = await response.json()
    participants.push(viewer.id)
    const rendered = await context.request.get('http://localhost:3000/account')
    const html = await rendered.text()
    expect(html.includes(label)).toBeTruthy()
    if (label.endsWith('B')) expect(html.includes('利用者A')).toBeFalsy()
    await page
      .getByRole('button', { name: 'このブラウザからログアウト' })
      .click()
    await expect(page).toHaveURL('/login')
  }
  expect(
    participants.length === 2 && participants[0] !== participants[1],
  ).toBeTruthy()
  await context.close()
})

test('Q-19/Q-21: invitation return path survives signup, email confirmation and profile setup', async ({ page }) => {
  const email = `join-signup-${Date.now()}@example.test`
  const path = '/join/000100200300'
  // A well-formed fake invite for a league that does not exist in the fixture.
  const code = '0123456789ABCDEF'
  await page.goto(path + '#code=' + code)
  await expect(page).toHaveURL(path)
  await page.getByRole('link', { name: '新規登録' }).click()
  await expect(page).toHaveURL(`/signup?returnTo=${encodeURIComponent(path)}`)
  await page.getByLabel('メールアドレス').fill(email)
  await page.getByLabel('パスワード').fill(password)
  await page.getByRole('button', { name: '登録して確認メールを受け取る' }).click()
  const link = await mailLink(email, '登録')
  const params = new URL(link).searchParams
  expect(params.get('returnTo')).toBe(path)
  expect(params.has('code')).toBeFalsy()
  await confirm(page, link)
  await expect(page).toHaveURL(`/profile/setup?returnTo=${encodeURIComponent(path)}`)
  await page.getByLabel('表示名').fill('招待復帰の試験')
  await page.getByRole('button', { name: '表示名を設定して進む' }).click()
  await expect(page).toHaveURL(path)
  await expect.poll(async () => (await page.getByLabel('参加コード').inputValue()) === code).toBeTruthy()
  const otherTab = await page.context().newPage()
  try {
    await otherTab.goto(path)
    await expect(otherTab.getByLabel('参加コード')).toBeEmpty()
    await expect(otherTab.getByText(/招待リンクを開き直すか/)).toBeVisible()
  } finally {
    await otherTab.close()
  }
  await expect(page.getByRole('button', { name: 'このリーグに参加' })).toHaveCount(0)
  await page.getByRole('button', { name: '招待を確認' }).click()
  await expect(page.getByRole('main').getByRole('alert')).toContainText('有効な招待がありません')
  await expect(page.getByLabel('参加コード')).toBeEmpty()
  await page.goto('/matches')
  await expect(page.getByText('所属しているリーグがありません。')).toBeVisible()
})
