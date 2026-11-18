import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const database = 'supabase_db_mj-stats-step1'
const api = 'http://localhost:8080'

function localSQL(input: string) {
  return execFileSync('docker', ['exec', '-i', database, 'psql', '-X', '-qAt', '-U', 'postgres',
    '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

async function signIn(page: Page, user: { email: string; password: string }) {
  await page.getByLabel('メールアドレス').fill(user.email)
  await page.getByLabel('パスワード', { exact: true }).fill(user.password)
  await page.getByRole('button', { name: 'ログイン', exact: true }).click()
}

async function openInvitation(page: Page, href: string) {
  try {
    await page.goto(href)
  } catch {
    throw new Error('招待リンクの遷移に失敗しました')
  }
}

test('Q-14/Q-19/Q-26: create, issue, join from three entrances, and scoped history', async ({ browser, request }) => {
  const local = JSON.parse(readFileSync('../.local/acceptance.json', 'utf8'))
  expect(local.API_URL).toBe('http://127.0.0.1:55421')
  const info = JSON.parse(execFileSync('docker', ['inspect', database], { encoding: 'utf8' }))[0]
  expect(info.Config.Labels['com.supabase.cli.project']).toBe('mj-stats-step1')
  expect(info.NetworkSettings.Ports['5432/tcp'].some((p: { HostPort: string }) => p.HostPort === '55422')).toBeTruthy()
  const authHeaders = { apikey: local.SERVICE_ROLE_KEY, Authorization: `Bearer ${local.SERVICE_ROLE_KEY}` }
  const authored: string[] = []
  async function user() {
    const email = `step2-7-${randomUUID()}@example.test`
    const password = `Qa-${randomUUID()}`
    const created = await request.post(`${local.API_URL}/auth/v1/admin/users`, {
      headers: authHeaders, data: { email, password, email_confirm: true },
    })
    expect(created.ok()).toBeTruthy()
    const { id } = await created.json()
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Auth fixture UUID')
    authored.push(id)
    return { id: id as string, email, password }
  }
  const origin = 'http://localhost:3000'
  const contextA = await browser.newContext({ baseURL: origin, viewport: { width: 390, height: 844 } })
  const contextB = await browser.newContext({ baseURL: origin, viewport: { width: 360, height: 800 } })
  const a = await contextA.newPage()
  const b = await contextB.newPage()
  const label = `試験リーグ ${randomUUID().slice(0, 8)}`
  const match = randomUUID()
  let leagueID = ''

  try {
    const owner = await user()
    const guest = await user()
    await test.step('create a league and add an isolated history fixture', async () => {
      await a.goto('/login')
      await signIn(a, owner)
      await expect(a).toHaveURL(/\/profile\/setup/)
      await a.getByLabel('表示名').fill('参加試験オーナー')
      await a.getByRole('button', { name: '表示名を設定して進む' }).click()
      await a.getByRole('link', { name: 'リーグを作成' }).click()
      await a.getByLabel('リーグ名').fill(label)
      await a.getByRole('button', { name: 'リーグを作成' }).click()
      await expect(a.getByRole('heading', { name: `${label}の対局履歴` })).toBeVisible()
      leagueID = new URL(a.url()).pathname.split('/').at(-1) ?? ''
      if (!/^[0-9a-f-]{36}$/.test(leagueID)) throw new Error('created league UUID')
      localSQL(`INSERT INTO public.matches(id,league_id,rule_id,recorded_by,match_date,data_origin)
        SELECT '${match}',l.id,r.id,l.owner_id,now(),'app' FROM public.leagues l
        JOIN public.rules r ON r.league_id=l.id WHERE l.id='${leagueID}';
        INSERT INTO public.match_results(league_id,match_id,user_id,raw_score,final_point,rank)
        SELECT id,'${match}',owner_id,31000,21.6,1 FROM public.leagues WHERE id='${leagueID}';`)
    })
    const history = `/matches/league/${leagueID}`
    await a.getByRole('link', { name: '招待を管理' }).click()
    await a.getByRole('button', { name: '現行の招待を取得' }).click()
    await expect(a.getByText('有効な招待はありません。')).toBeVisible()
    await a.getByRole('button', { name: '招待を発行' }).click()
    const linkInput = a.getByLabel('招待リンク', { exact: true })
    await expect(linkInput).toBeVisible()
    const oldLink = await linkInput.inputValue()
    const oldCode = await a.getByLabel('参加コード').inputValue()
    const url = new URL(oldLink)
    const path = url.pathname
    const canonical = oldCode.replaceAll('-', '')
    expect(url.origin === origin && url.hash === '#code=' + canonical).toBeTruthy()
    await a.getByRole('button', { name: '現行の招待を取得' }).click()
    await expect.poll(async () => (await linkInput.inputValue()) === oldLink).toBeTruthy()

    const pendingCleared = () => b.evaluate(() => sessionStorage.getItem('mjstats.pending-invite') === null)
    await test.step('open the link once, then authenticate without forwarding the code', async () => {
      let leaked = false
      b.on('request', (r) => { if (new URL(r.url()).search.includes(canonical)) leaked = true })
      await openInvitation(b, oldLink)
      await expect(b).toHaveURL(path)
      await expect(b.getByRole('link', { name: '新規登録' })).toHaveAttribute('href', `/signup?returnTo=${encodeURIComponent(path)}`)
      await b.getByRole('link', { name: 'ログイン' }).click()
      await expect(b).toHaveURL(`/login?returnTo=${encodeURIComponent(path)}`)
      await signIn(b, guest)
      await b.getByRole('link', { name: '表示名を設定' }).click()
      await expect(b).toHaveURL(`/profile/setup?returnTo=${encodeURIComponent(path)}`)
      await b.getByLabel('表示名').fill('参加試験メンバー')
      await b.getByRole('button', { name: '表示名を設定して進む' }).click()
      await expect(b).toHaveURL(path)
      await expect.poll(async () => (await b.getByLabel('参加コード').inputValue()) === canonical).toBeTruthy()
      await expect(b.getByRole('button', { name: 'このリーグに参加' })).toHaveCount(0)
      const doc = await b.request.get(path)
      expect(doc.headers()['cache-control']).toContain('no-store')
      expect((await doc.text()).includes(canonical)).toBeFalsy()
      expect(leaked).toBeFalsy()
      await b.goto(history)
      await expect(b.getByRole('main').getByRole('alert')).toHaveText('このリーグは閲覧できません。')
      await b.goto(path)
      await expect.poll(async () => (await b.getByLabel('参加コード').inputValue()) === canonical).toBeTruthy()
      await b.getByRole('button', { name: '招待を確認' }).click()
      await expect(b.getByRole('button', { name: 'このリーグに参加' })).toBeVisible()
      expect(localSQL(`SELECT count(*) FROM public.league_members WHERE league_id='${leagueID}'`)).toBe('1')
    })

    await test.step('join only on submit and retry the same operation after a lost response', async () => {
      const join = `${api}/api/leagues/${leagueID}/join`
      const operationIDs: string[] = []
      let accepted = false
      await b.route(join, async (route) => {
        if (route.request().method() !== 'POST') return route.continue()
        operationIDs.push(route.request().postDataJSON().client_request_id)
        if (operationIDs.length === 1) {
          const response = await route.fetch()
          accepted = response.ok()
          return route.abort()
        }
        await route.continue()
      })
      await b.getByRole('button', { name: 'このリーグに参加' }).click()
      await expect(b.getByRole('main').getByRole('alert')).toContainText('送信結果を確認できませんでした')
      expect(accepted).toBeTruthy()
      await b.getByRole('button', { name: '参加を再試行' }).click()
      await expect(b).toHaveURL(history)
      expect(await pendingCleared()).toBeTruthy()
      expect(operationIDs.length === 2 && operationIDs[0] === operationIDs[1]).toBeTruthy()
      expect(localSQL(`SELECT count(*) FROM public.league_events WHERE league_id='${leagueID}' AND operation='league.join'`)).toBe('1')
      await b.unroute(join)
      await expect(b.getByText('31,000点', { exact: false })).toBeVisible()
      await expect(b.getByText('対局の計算・記録は現在利用できません。')).toBeVisible()
      await b.goto(history + '/invites')
      await expect(b.getByRole('main').getByRole('alert')).toHaveText('このリーグの招待は管理できません。')
    })

    const member = localSQL(`SELECT id FROM public.users WHERE auth_id='${guest.id}'`)
    if (!/^[0-9a-f-]{36}$/.test(member)) throw new Error('participant fixture UUID')
    localSQL(`INSERT INTO public.match_results(league_id,match_id,user_id,raw_score,final_point,rank)
      VALUES ('${leagueID}','${match}','${member}',29000,4.2,2);`)
    const endMembership = (state: 'left' | 'removed') => localSQL(`UPDATE public.league_members
      SET status='${state}',ended_at=now(),version=version+1
      WHERE league_id='${leagueID}' AND user_id='${member}';`)
    const enter = async (code: string) => {
      await b.getByLabel('参加コード').fill(code)
      await b.getByRole('button', { name: '招待を確認' }).click()
    }
    async function joinFromPreview() {
      await b.getByRole('button', { name: 'このリーグに参加' }).click()
      await expect(b).toHaveURL(history)
      await expect(b.getByText('29,000点', { exact: false })).toBeVisible()
    }

    await test.step('rejoin after leaving by number and after removal by listed name', async () => {
      endMembership('left')
      await b.goto(history)
      await expect(b.getByRole('main').getByRole('alert')).toHaveText('このリーグは閲覧できません。')
      await b.goto('/matches')
      await expect(b.getByText('所属しているリーグがありません。')).toBeVisible()
      await b.getByRole('link', { name: 'リーグに参加' }).click()
      const search = b.getByLabel('公開されているリーグ名')
      await search.fill(label)
      await b.getByRole('button', { name: '名前で検索' }).click()
      await expect(b.getByText('該当するリーグはありません。')).toBeVisible()
      await b.getByLabel('12桁のグループ番号').fill(path.split('/').at(-1)!)
      await b.getByRole('button', { name: '番号で探す' }).click()
      await expect(b).toHaveURL(path)
      await enter(oldCode)
      await joinFromPreview()

      endMembership('removed')
      localSQL(`UPDATE public.leagues SET search_listed=true WHERE id='${leagueID}';`)
      await a.getByRole('button', { name: '招待を再発行' }).click()
      await expect.poll(async () => (await linkInput.inputValue()) !== oldLink).toBeTruthy()
      const newCode = await a.getByLabel('参加コード').inputValue()
      await b.goto('/leagues/search')
      await search.fill(label)
      await b.getByRole('button', { name: '名前で検索' }).click()
      await b.getByRole('link', { name: new RegExp(label) }).click()
      await expect(b).toHaveURL(path)
      await enter(oldCode)
      await expect(b.getByRole('main').getByRole('alert')).toContainText('有効な招待がありません')
      await enter(newCode)
      await joinFromPreview()
      await a.getByRole('button', { name: 'この招待を失効' }).click()
      await expect(a.getByText('この招待は失効しました。')).toBeVisible()
      await expect(a.getByLabel('参加コード')).toHaveCount(0)
      await b.goto(path)
      await enter(newCode)
      await expect(b.getByRole('main').getByRole('alert')).toContainText('有効な招待がありません')
      await b.goto(history)
      await expect(b.getByText('29,000点', { exact: false })).toBeVisible()
    })
    await test.step('reject expired and malformed codes and discard the tab handoff', async () => {
      await a.getByRole('button', { name: '招待を発行' }).click()
      await expect(linkInput).toBeVisible()
      const expiringLink = await linkInput.inputValue()
      await openInvitation(b, expiringLink)
      await expect(b).toHaveURL(path)
      await expect(b.getByRole('button', { name: '招待を確認' })).toBeEnabled()
      localSQL(`WITH stamp AS (SELECT clock_timestamp() AS t)
        UPDATE public.league_invites SET issued_at=t-interval '168 hours', expires_at=t
        FROM stamp WHERE league_id='${leagueID}' AND revoked_at IS NULL;`)
      const previewResponse = () => b.waitForResponse((r) =>
        r.url().endsWith('/api/leagues/join-preview') && r.request().method() === 'POST')
      const expired = previewResponse()
      await b.getByRole('button', { name: '招待を確認' }).click()
      const rejected = await expired
      expect(rejected.status()).toBe(404)
      expect((await rejected.json()).error.code).toBe('INVALID_INVITE')
      await expect(b.getByRole('main').getByRole('alert')).toContainText('有効な招待がありません')
      expect(await pendingCleared()).toBeTruthy()
      await b.reload()
      await expect(b.getByLabel('参加コード')).toBeEmpty()

      await openInvitation(b, `${origin}${path}#code=invalid-format`)
      await expect(b).toHaveURL(path)
      await expect(b.getByRole('button', { name: '招待を確認' })).toBeEnabled()
      const malformed = previewResponse()
      await b.getByRole('button', { name: '招待を確認' }).click()
      const invalid = await malformed
      expect(invalid.status()).toBe(400)
      expect((await invalid.json()).error.code).toBe('INVALID_INPUT')
      await expect(b.getByRole('main').getByRole('alert')).toHaveText('参加コードの形式を確認してください。')
      expect(await pendingCleared()).toBeTruthy()
    })

    await test.step('expire the short-lived handoff', async () => {
      await b.clock.install()
      await openInvitation(b, oldLink)
      await expect(b).toHaveURL(path)
      expect(await pendingCleared()).toBeFalsy()
      await b.clock.fastForward(15 * 60_000 + 1_000)
      await expect(b.getByLabel('参加コード')).toBeEmpty()
      expect(await pendingCleared()).toBeTruthy()
      await b.clock.setSystemTime(Date.now())
    })

    await test.step('discard retained code after switching the authenticated subject and after logging out', async () => {
      await openInvitation(b, oldLink)
      await expect(b).toHaveURL(path)
      await expect(b.getByRole('button', { name: '招待を確認' })).toBeEnabled()
      expect(await pendingCleared()).toBeFalsy()
      const ownerCookies = (await contextA.cookies(origin)).filter((c) => /sb-.*-auth-token/.test(c.name))
      expect(ownerCookies.length > 0).toBeTruthy()
      await contextB.clearCookies({ name: /sb-.*-auth-token/ })
      await contextB.addCookies(ownerCookies)
      await b.reload()
      await expect(b.getByText('参加試験オーナー', { exact: true })).toBeVisible()
      await expect(b.getByLabel('参加コード')).toBeEmpty()
      expect(await pendingCleared()).toBeTruthy()

      await openInvitation(b, oldLink)
      await expect(b).toHaveURL(path)
      await expect(b.getByRole('button', { name: '招待を確認' })).toBeEnabled()
      expect(await pendingCleared()).toBeFalsy()
      await b.getByRole('link', { name: 'アカウント' }).click()
      await b.getByRole('button', { name: 'このブラウザからログアウト' }).click()
      await expect(b).toHaveURL(/\/login/)
      expect(await pendingCleared()).toBeTruthy()
    })
    expect(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    expect(localSQL(`SELECT count(*) FROM public.league_members WHERE league_id='${leagueID}' AND status='active'`)).toBe('2')
  } finally {
    await contextA.close()
    await contextB.close()
    if (leagueID && /^[0-9a-f-]{36}$/.test(leagueID)) {
      localSQL(`BEGIN;
        DELETE FROM public.league_events WHERE league_id='${leagueID}';
        DELETE FROM public.league_invites WHERE league_id='${leagueID}';
        DELETE FROM public.match_results WHERE league_id='${leagueID}';
        DELETE FROM public.matches WHERE league_id='${leagueID}';
        DELETE FROM public.rules WHERE league_id='${leagueID}';
        DELETE FROM public.league_members WHERE league_id='${leagueID}';
        DELETE FROM public.leagues WHERE id='${leagueID}';
        COMMIT;`)
    }
    for (const authID of authored) {
      localSQL(`DELETE FROM public.users WHERE auth_id='${authID}';`)
      await request.delete(`${local.API_URL}/auth/v1/admin/users/${authID}`, { headers: authHeaders })
    }
  }
})
