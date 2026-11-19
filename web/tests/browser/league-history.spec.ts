import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomInt, randomUUID } from 'node:crypto'

const container = 'supabase_db_mj-stats-step1'
const api = 'http://localhost:8080'

function localSQL(input: string) {
  execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-q', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
    input, stdio: ['pipe', 'pipe', 'pipe'],
  })
}

test('Q-14/Q-19/Q-26: scoped history, home states and legacy selection', async ({ page, request }, testInfo) => {
  const config = JSON.parse(readFileSync('../.local/acceptance.json', 'utf8'))
  expect(config.API_URL).toBe('http://127.0.0.1:55421')
  const info = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0]
  expect(info.Config.Labels['com.supabase.cli.project']).toBe('mj-stats-step1')
  expect(info.NetworkSettings.Ports['5432/tcp'].some((p: { HostPort: string }) => p.HostPort === '55422')).toBeTruthy()

  async function user(name: string) {
    const email = `league-${randomUUID()}@example.test`
    const password = `Qa-${randomUUID()}`
    const adminHeaders = { apikey: config.SERVICE_ROLE_KEY, Authorization: `Bearer ${config.SERVICE_ROLE_KEY}` }
    const created = await request.post(`${config.API_URL}/auth/v1/admin/users`, {
      headers: adminHeaders, data: { email, password, email_confirm: true },
    })
    expect(created.ok()).toBeTruthy()
    const login = await request.post(`${config.API_URL}/auth/v1/token?grant_type=password`, {
      headers: { apikey: config.ANON_KEY }, data: { email, password },
    })
    expect(login.ok()).toBeTruthy()
    const { access_token } = await login.json()
    const headers = { Authorization: `Bearer ${access_token}` }
    const me = await request.get(`${api}/api/users/me`, { headers })
    expect(me.ok()).toBeTruthy()
    const { id } = await me.json()
    const updated = await request.patch(`${api}/api/users/me`, { headers, data: { name } })
    expect(updated.ok()).toBeTruthy()
    if (!/^[\da-f-]{36}$/i.test(id)) throw new Error('Invalid local participant ID')
    return { id, email, password }
  }
  async function signIn(p: Page, credentials: Awaited<ReturnType<typeof user>>) {
    await p.getByLabel('メールアドレス').fill(credentials.email)
    await p.getByLabel('パスワード', { exact: true }).fill(credentials.password)
    await p.getByRole('button', { name: 'ログイン', exact: true }).click()
  }
  const a = await user('履歴の参加者A')
  const b = await user('履歴の参加者B')
  const leagueA = randomUUID(), leagueB = randomUUID()
  const pathA = `/matches/league/${leagueA}`, pathB = `/matches/league/${leagueB}`
  const rule = randomUUID(), season = randomUUID()
  const number = () => String(randomInt(100000000000, 999999999999))
  localSQL(`BEGIN;
    INSERT INTO public.leagues(id,name,owner_id,group_number) VALUES
      ('${leagueA}','ブラウザリーグA','${a.id}','${number()}'),
      ('${leagueB}','ブラウザリーグB','${b.id}','${number()}');
    INSERT INTO public.league_members(league_id,user_id,participant_kind,role,status) VALUES
      ('${leagueA}','${a.id}','registered','owner','active'),
      ('${leagueB}','${b.id}','registered','owner','active'),
      ('${leagueB}','${a.id}','registered','member','active');
    INSERT INTO public.rules(id,league_id,name,uma_1,uma_2,uma_3,uma_4,calculation_version,available)
      VALUES ('${rule}','${leagueA}','ブラウザルール',20,10,-10,-20,'exact_v1',true);
    INSERT INTO public.seasons(id,league_id,name) VALUES ('${season}','${leagueA}','秋のシーズン');
    WITH inserted AS (
      INSERT INTO public.matches(league_id,rule_id,season_id,recorded_by,match_date,created_at,data_origin)
      SELECT '${leagueA}','${rule}',CASE WHEN i=21 THEN '${season}'::uuid END,'${a.id}',
        '2026-10-31 15:00:00Z'::timestamptz + i*interval '1 day',NULL,'app' FROM generate_series(1,21) i
      RETURNING league_id,id,season_id
    )
    INSERT INTO public.match_results(league_id,match_id,user_id,raw_score,final_point,rank,final_point_numerator,final_point_denominator)
      SELECT league_id,id,'${a.id}',CASE WHEN season_id IS NULL THEN 25000 ELSE 33000 END,16.7,1,167,10 FROM inserted;
    COMMIT;`)
  try {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(pathA)
    await expect(page).toHaveURL(`/login?returnTo=${encodeURIComponent(pathA)}`)
    await signIn(page, a)
    await expect(page).toHaveURL(pathA)
    await expect(page.getByRole('heading', { name: 'ブラウザリーグAの対局履歴' })).toBeVisible()
    const first = await page.request.get(pathA)
    expect(first.headers()['cache-control']).toContain('no-store')
    expect(await first.text()).toContain('33,000')
    await expect(page.getByRole('link', { name: '対局を入力' })).toHaveAttribute('href', pathA + '/new')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
    await page.getByRole('link', { name: '次の対局を表示' }).click()
    await expect(page).toHaveURL(/cursor=/)
    await expect(page.getByText('25,000点', { exact: false })).toHaveCount(1)
    await expect(page.getByText('33,000点', { exact: false })).toHaveCount(0)
    await page.getByLabel('シーズン').selectOption(season)
    await page.getByRole('button', { name: '表示する' }).click()
    await expect(page).toHaveURL(`${pathA}?season=${season}`)
    await expect(page.getByText('33,000点', { exact: false })).toHaveCount(1)
    await page.evaluate(() => sessionStorage.removeItem('mjstats.selected-league'))
    await page.goto('/matches/new')
    await expect(page.getByRole('heading', { name: '対局入力のリーグを選択' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'ブラウザリーグA オーナー' })).toHaveAttribute('href', pathA + '/new')
    await expect(page.getByRole('link', { name: 'ブラウザリーグB メンバー' })).toHaveAttribute('href', pathB + '/new')
    await page.goto('/matches')
    await expect(page.getByRole('heading', { name: '対局履歴のリーグを選択' })).toBeVisible()
    await page.getByRole('link', { name: 'ブラウザリーグA オーナー' }).click()
    await expect(page).toHaveURL(pathA)
    await expect(page.getByText('33,000点', { exact: false })).toBeVisible()
    await page.goto('/matches/new')
    await expect(page).toHaveURL(pathA + '/new')
    await page.getByRole('link', { name: 'ホーム', exact: true }).click()
    await expect(page.getByRole('link', { name: 'ブラウザリーグA オーナー' })).toBeVisible()
    await page.getByRole('link', { name: 'ブラウザリーグB メンバー' }).click()
    await expect(page).toHaveURL(`/leagues/${leagueB}`)
    await page.getByRole('link', { name: '対局履歴', exact: true }).click()
    await expect(page).toHaveURL(pathB)
    await expect(page.getByText('対象の対局はありません。')).toBeVisible()
    await expect(page.getByText('履歴の参加者A', { exact: false }).filter({ hasText: '1位' })).toHaveCount(0)

    // Fail just the real history SELECT, leaving Auth and the league list live.
    localSQL('REVOKE SELECT ON public.matches FROM mjstats_api;')
    try {
      await page.goto(pathB)
      await expect(page.getByRole('main').getByRole('alert')).toHaveText('対局履歴を取得できませんでした。')
    } finally {
      localSQL('GRANT SELECT ON public.matches TO mjstats_api;')
    }
    await page.getByRole('link', { name: '履歴を読み直す' }).click()
    await expect(page.getByText('対象の対局はありません。')).toBeVisible()
    await expect(page.getByRole('link', { name: '対局を記録する' })).toHaveAttribute('href', pathB + '/new')
    await page.goto('/matches')
    await expect(page).toHaveURL(pathB)

    const connection = spawn('docker', ['exec', '-i', container, 'psql', '-X', '-qAt',
      '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] })
    const closed = once(connection, 'close')
    try {
      const locked = once(connection.stdout, 'data')
      connection.stdin.write("BEGIN; LOCK TABLE public.leagues IN ACCESS EXCLUSIVE MODE; SELECT 'locked';\n")
      await expect.poll(async () => await locked.then(([chunk]) => String(chunk).trim())).toBe('locked')
      await page.goto('/', { waitUntil: 'commit' })
      await expect(page.getByRole('status').filter({ hasText: '所属リーグを読み込んでいます' })).toBeVisible({ timeout: 3000 })
      await page.screenshot({ path: testInfo.outputPath('home-loading.png'), timeout: 3000 })
    } finally {
      connection.stdin.end('COMMIT;\n')
      expect((await closed)[0]).toBe(0)
    }
    await expect(page.getByRole('link', { name: 'ブラウザリーグB メンバー' })).toBeVisible()

    localSQL('REVOKE SELECT ON public.leagues FROM mjstats_api;')
    try {
      await page.goto('/')
      await expect(page.getByRole('main').getByRole('alert')).toHaveText('所属リーグを取得できませんでした。')
      await expect(page.getByText('所属しているリーグがありません。')).toHaveCount(0)
    } finally {
      localSQL('GRANT SELECT ON public.leagues TO mjstats_api;')
    }
    await page.getByRole('link', { name: '再試行', exact: true }).click()
    await expect(page.getByRole('link', { name: 'ブラウザリーグA オーナー' })).toBeVisible()

    // The saved selection must be checked against the next Go list.
    localSQL(`UPDATE public.league_members SET status='left', ended_at=now(), version=version+1
      WHERE league_id='${leagueB}' AND user_id='${a.id}';`)
    await page.goto('/matches')
    await expect(page).toHaveURL(pathA)
    await page.goto(`/leagues/${leagueB}`)
    await expect(page.getByRole('main').getByRole('alert')).toHaveText('このリーグは閲覧できません。')
    await expect(page.getByRole('link', { name: '対局を入力' })).toHaveCount(0)
    await page.getByRole('link', { name: 'アカウント' }).click()
    await page.getByRole('button', { name: 'このブラウザからログアウト' }).click()
    await expect(page).toHaveURL(/\/login/)
    await page.goto(pathA)
    await signIn(page, b)
    await expect(page.getByRole('main').getByRole('alert')).toHaveText('このリーグは閲覧できません。')
    await expect(page.getByText('33,000点', { exact: false })).toHaveCount(0)
    await page.getByRole('link', { name: '所属リーグ一覧へ' }).click()
    await expect(page.getByRole('link', { name: 'ブラウザリーグB オーナー' })).toBeVisible()
    await expect(page.getByRole('link', { name: /ブラウザリーグA/ })).toHaveCount(0)
    await page.goto('/matches/new')
    await expect(page).toHaveURL(pathB + '/new')
    await expect(page.getByLabel('素点 1', { exact: true })).toHaveValue('')
  } finally {
    localSQL(`BEGIN;
      DELETE FROM public.match_results WHERE league_id IN ('${leagueA}','${leagueB}');
      DELETE FROM public.matches WHERE league_id IN ('${leagueA}','${leagueB}');
      DELETE FROM public.rules WHERE league_id IN ('${leagueA}','${leagueB}');
      DELETE FROM public.seasons WHERE league_id IN ('${leagueA}','${leagueB}');
      DELETE FROM public.league_members WHERE league_id IN ('${leagueA}','${leagueB}');
      DELETE FROM public.leagues WHERE id IN ('${leagueA}','${leagueB}');
      COMMIT;`)
  }
})
