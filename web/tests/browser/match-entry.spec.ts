import { test, expect, type Page } from "@playwright/test"
import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"

const container = "supabase_db_mj-stats-step1"
const api = "http://localhost:8080"

test.use({ launchOptions: { ignoreDefaultArgs: ["--disable-back-forward-cache"] } })

function localSQL(input: string) {
  return execFileSync("docker", ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres",
    "-d", "postgres", "-v", "ON_ERROR_STOP=1"], {
    input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  }).trim()
}

test("Q-09/Q-10/Q-19/Q-26: home, guest entry, exact history and safe draft recovery", async ({ page, request, browser, browserName }, testInfo) => {
  test.setTimeout(180_000)
  const cfg = JSON.parse(readFileSync("../.local/acceptance.json", "utf8"))
  expect(cfg.API_URL).toBe("http://127.0.0.1:55421")
  const info = JSON.parse(execFileSync("docker", ["inspect", container], { encoding: "utf8" }))[0]
  expect(info.Config.Labels["com.supabase.cli.project"]).toBe("mj-stats-step1")
  expect(info.NetworkSettings.Ports["5432/tcp"].some((p: { HostPort: string }) => p.HostPort === "55422")).toBe(true)
  const adminHeaders = { apikey: cfg.SERVICE_ROLE_KEY, Authorization: `Bearer ${cfg.SERVICE_ROLE_KEY}` }
  const authIDs: string[] = []
  const participantIDs: string[] = []
  const leagues: string[] = []
  const guests: string[] = []
  function uuid(id: unknown): string {
    if (typeof id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw new Error("local fixture ID")
    return id
  }
  async function createUser(name: string) {
    const email = `step3-${randomUUID()}@example.test`
    const password = `Qa-${randomUUID()}`
    const created = await request.post(`${cfg.API_URL}/auth/v1/admin/users`, {
      headers: adminHeaders, data: { email, password, email_confirm: true },
    })
    expect(created.ok()).toBe(true)
    authIDs.push(uuid((await created.json()).id))
    const token = await request.post(`${cfg.API_URL}/auth/v1/token?grant_type=password`, {
      headers: { apikey: cfg.ANON_KEY }, data: { email, password },
    })
    expect(token.ok()).toBe(true)
    const headers = { Authorization: `Bearer ${(await token.json()).access_token}` }
    const me = await request.get(`${api}/api/users/me`, { headers })
    expect(me.ok()).toBe(true)
    const id = uuid((await me.json()).id)
    participantIDs.push(id)
    expect((await request.patch(`${api}/api/users/me`, { headers, data: { name } })).ok()).toBe(true)
    return { email, password, headers, id }
  }
  async function createLeague(owner: Awaited<ReturnType<typeof createUser>>, name: string) {
    const res = await request.post(`${api}/api/leagues`, {
      headers: owner.headers, data: { name, client_request_id: randomUUID() },
    })
    expect(res.status()).toBe(201)
    const { league } = await res.json()
    const id = uuid(league.id)
    leagues.push(id)
    return id
  }
  async function signIn(p: Page, user: { email: string; password: string }) {
    await p.getByLabel("メールアドレス").fill(user.email)
    await p.getByLabel("パスワード", { exact: true }).fill(user.password)
    await p.getByRole("button", { name: "ログイン", exact: true }).click()
  }

  try {
    const owner = await createUser("対局試験 オーナー")
    const member = await createUser("対局試験 メンバー")
    const a = await createLeague(owner, "ゲスト記録リーグ")
    const b = await createLeague(owner, "別の記録リーグ")
    localSQL(`INSERT INTO public.league_members(league_id,user_id,participant_kind,role,status)
      VALUES('${a}','${member.id}','registered','member','active');`)
    const history = `/matches/league/${a}`
    const entry = `${history}/new`
    const saveURL = `${api}/api/leagues/${a}/matches`
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto("/login?returnTo=https%3A%2F%2Fevil.invalid")
    await signIn(page, owner)
    await expect(page).toHaveURL("/")
    await page.getByRole("link", { name: "ゲスト記録リーグ オーナー" }).click()
    await expect(page).toHaveURL(`/leagues/${a}`)
    await page.getByRole("link", { name: "対局を入力" }).click()
    await expect(page).toHaveURL(entry)
    await page.getByText("ゲストを追加", { exact: true }).click()
    for (const name of ["同名ゲスト", "同名ゲスト", "ゲスト三", "ゲスト四"]) {
      await page.getByLabel("ゲスト名", { exact: true }).fill(name)
      const response = page.waitForResponse((res) => res.url().endsWith("/guests") && res.request().method() === "POST")
      await page.getByRole("button", { name: "候補に追加" }).click()
      const saved = await response
      expect(saved.status()).toBe(201)
      guests.push(uuid((await saved.json()).participant.id))
      await expect(page.getByText(`${name}を候補に追加しました。`)).toBeVisible()
    }
    expect(new Set(guests).size).toBe(4)
    const scores = ["33300", "33300", "33300", "100"]
    for (let i = 0; i < guests.length; i++) {
      await page.getByRole("combobox", { name: `参加者 ${i + 1}`, exact: true }).selectOption(guests[i])
      await page.getByLabel(`素点 ${i + 1}`, { exact: true }).fill(i === 3 ? "101" : scores[i])
    }
    await page.getByLabel("対局日（日本時間）").fill("2024-11-01")
    await page.getByLabel("開始時刻（日本時間）").fill("00:00")
    await expect(page.getByLabel("シーズン")).toHaveValue("")
    await page.getByRole("button", { name: "計算する" }).click()
    await expect(page.getByRole("main").getByRole("alert")).toContainText("100点単位")
    await expect(page.getByLabel("素点 4", { exact: true })).toHaveValue("101")
    await page.getByLabel("素点 4", { exact: true }).fill(scores[3])

    await page.getByRole("link", { name: "ホーム", exact: true }).click()
    await page.getByRole("link", { name: "別の記録リーグ オーナー" }).click()
    await page.getByRole("link", { name: "対局を入力" }).click()
    await expect(page.getByLabel("素点 1", { exact: true })).toHaveValue("")
    await expect(page.getByRole("option", { name: /同名ゲスト/ })).toHaveCount(0)
    await page.goBack()
    await expect(page.getByRole("heading", { name: "別の記録リーグ", exact: true })).toBeVisible()
    await page.goto(entry)
    await expect(page.getByRole("combobox", { name: "参加者 1", exact: true })).toHaveValue(guests[0])
    await expect(page.getByLabel("素点 1", { exact: true })).toHaveValue("33300")
    await page.getByRole("button", { name: "計算する" }).click()
    await expect(page.getByText("+16.6333… pt", { exact: false })).toHaveCount(3)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    let originalBody: string | null = null
    let matchID = ""
    await page.route(saveURL, async (route) => {
      if (route.request().method() !== "POST") return route.continue()
      originalBody = route.request().postData()
      const result = await route.fetch()
      expect(result.status()).toBe(201)
      matchID = uuid((await result.json()).id)
      await route.abort("connectionreset")
    })
    await page.getByRole("button", { name: "保存する" }).click()
    await expect(page.getByText("保存結果を確認できません。同じ内容で再送してください。")).toBeVisible()
    await page.unroute(saveURL)
    await page.reload()
    await expect(page.getByLabel("素点 1", { exact: true })).toHaveValue("33300")
    await expect(page.getByLabel("素点 1", { exact: true })).toBeDisabled()

    // Revoke in Auth without an in-app logout. Go must return a real 401, while
    // the browser retains the exact bytes from the previously committed write.
    localSQL(`DELETE FROM auth.sessions WHERE user_id='${authIDs[0]}';`)
    const unauthorized = page.waitForResponse((res) => res.url() === saveURL &&
      res.request().method() === "POST" && res.status() === 401)
    await page.getByRole("button", { name: "同じ内容で再送" }).click()
    expect((await unauthorized).request().postData()).toBe(originalBody)
    await expect(page).toHaveURL(`/login?returnTo=${encodeURIComponent(entry)}`)
    await signIn(page, owner)
    await expect(page).toHaveURL(entry)
    await expect(page.getByRole("button", { name: "同じ内容で再送" })).toBeVisible()
    await page.route(saveURL, async (route) => {
      if (route.request().method() !== "POST") return route.continue()
      expect(route.request().postData()).toBe(originalBody)
      const result = await route.fetch()
      expect(result.status()).toBe(200)
      expect((await result.json()).id).toBe(matchID)
      await route.fulfill({ response: result })
    })
    await page.getByRole("button", { name: "同じ内容で再送" }).click()
    await expect(page.getByText("対局を保存しました。")).toBeVisible()
    await page.unroute(saveURL)
    expect(localSQL(`SELECT (SELECT count(*) FROM public.matches WHERE league_id='${a}'),
      (SELECT count(*) FROM public.match_results WHERE match_id='${matchID}'),
      (SELECT count(*) FROM public.match_revisions WHERE match_id='${matchID}');`)).toBe("1|4|1")
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("mjstats.match-entry.v2:")))).toEqual([])
    await page.getByRole("link", { name: "保存した対局を見る" }).click()
    await expect(page).toHaveURL(`${history}/${matchID}`)
    await expect(page.getByText("+16.6333… pt", { exact: false })).toHaveCount(3)
    await page.getByText("正確な値と参加者ID").first().click()
    await expect(page.getByText("499/30 pt", { exact: true }).filter({ visible: true })).toHaveCount(1)
    await expect(page.getByText("未指定", { exact: true })).toBeVisible()

    await page.getByRole("link", { name: "対局履歴", exact: true }).click()
    await expect(page.getByText("+16.6333… pt", { exact: false })).toHaveCount(3)
    await page.getByRole("link", { name: "ゲストの本人紐付け" }).click()
    await page.getByRole("combobox", { name: "ゲスト", exact: true }).selectOption(guests[0])
    await page.getByRole("checkbox").check()
    await page.getByRole("button", { name: "本人として申請" }).click()
    await expect(page.getByText("確認待ち")).toBeVisible()
    await page.getByRole("button", { name: "申請を確認" }).click()
    await page.getByLabel("確認内容").fill("本人を確認")
    await page.getByRole("button", { name: "承認", exact: true }).click()
    await expect(page.getByText("承認済み", { exact: true })).toBeVisible()
    await page.goto(`${history}/${matchID}`)
    await expect(page.getByText("対局試験 オーナー", { exact: false }).filter({ hasText: "1位" })).toBeVisible()
    expect(localSQL(`SELECT count(*) FROM public.match_results WHERE match_id='${matchID}' AND user_id='${guests[0]}'`)).toBe("1")

    await page.getByRole("link", { name: "対局履歴", exact: true }).click()
    await page.getByRole("link", { name: "対局を入力" }).click()
    await expect(page.getByLabel("素点 1", { exact: true })).toHaveValue("")
    const nextScores = ["60000", "30000", "15000", "-5000"]
    const firstPlayer = page.getByRole("combobox", { name: "参加者 1", exact: true })
    await expect(firstPlayer.locator(`option[value="${guests[0]}"]`)).toHaveCount(0)
    const nextPlayers = [owner.id, ...guests.slice(1, 3), member.id]
    for (let i = 0; i < nextPlayers.length; i++) {
      await page.getByRole("combobox", { name: `参加者 ${i + 1}`, exact: true }).selectOption(nextPlayers[i])
      await page.getByLabel(`素点 ${i + 1}`, { exact: true }).fill(nextScores[i])
    }
    await page.getByLabel("対局日（日本時間）").fill("2024-11-02")
    await page.getByLabel("開始時刻（日本時間）").fill("00:00")
    await page.getByRole("button", { name: "計算する" }).click()
    await expect(page.getByText("−55 pt", { exact: false })).toBeVisible()
    await page.getByRole("button", { name: "保存する" }).click()
    await page.getByRole("link", { name: "保存した対局を見る" }).click()
    await expect(page.getByText("−55 pt", { exact: false })).toBeVisible()
    expect(localSQL(`SELECT count(*) FILTER (WHERE user_id='${guests[0]}'),
      count(*) FILTER (WHERE user_id='${owner.id}') FROM public.match_results WHERE league_id='${a}'`)).toBe("1|1")

    await test.step("360/390/768/1280 CSS px, 200% text, touch, landscape and visible keyboard focus", async () => {
      const state = await page.context().storageState()
      const touch = await browser.newContext({ storageState: state, viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true })
      const touchPage = await touch.newPage()
      const checkLayout = async (target: Page) => {
        await target.locator("html").evaluate((html) => html.style.fontSize = "200%")
        expect(await target.evaluate(() => ({
          width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
          rem: getComputedStyle(document.documentElement).fontSize,
        }))).toEqual({ width: target.viewportSize()!.width, scroll: target.viewportSize()!.width, rem: "32px" })
      }
      try {
        await touchPage.goto("/")
        await expect(touchPage.getByRole("link", { name: "ゲスト記録リーグ オーナー" })).toBeVisible()
        await checkLayout(touchPage)
        await touchPage.screenshot({ path: testInfo.outputPath("home-360-text200.png"), fullPage: true })
        await touchPage.getByRole("link", { name: "ゲスト記録リーグ オーナー" }).tap()
        await touchPage.getByRole("link", { name: "対局を入力" }).tap()
        await expect(touchPage.getByLabel("素点 1", { exact: true })).toBeEditable()
        await checkLayout(touchPage)
        await expect(touchPage.getByLabel("対局日（日本時間）")).toBeVisible()
        await expect(touchPage.getByLabel("開始時刻（日本時間）")).toBeVisible()
        await touchPage.getByLabel("素点 1", { exact: true }).tap()
        await expect(touchPage.getByLabel("素点 1", { exact: true })).toBeFocused()
        await touchPage.screenshot({ path: testInfo.outputPath("entry-360-text200.png"), fullPage: true })
        await touchPage.setViewportSize({ width: 844, height: 390 })
        await checkLayout(touchPage)
        await touchPage.screenshot({ path: testInfo.outputPath("entry-landscape-text200.png"), fullPage: true })
      } finally {
        await touch.close()
      }
      for (const width of [390, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 })
        await page.goto(history)
        await expect(page.getByRole("link", { name: "対局詳細" }).first()).toBeVisible()
        await checkLayout(page)
        await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab")
        const home = page.getByRole("link", { name: "ホーム", exact: true })
        await expect(home).toBeFocused()
        expect(await home.evaluate((el) => el.matches(":focus-visible") && getComputedStyle(el).outlineStyle !== "none")).toBe(true)
        await page.screenshot({ path: testInfo.outputPath(`history-${width}-text200.png`), fullPage: true })
        await page.keyboard.press("Enter")
        await expect(page).toHaveURL("/")
      }
    })

    await test.step("discard drafts on 24h expiry, explicit logout across tabs and account changes", async () => {
      const score = () => page.getByLabel("素点 1", { exact: true })
      const logout = () => page.getByRole("button", { name: "このブラウザからログアウト" }).click()
      const draftCount = (target: Page) => target.evaluate(() =>
        Object.keys(sessionStorage).filter((key) => key.startsWith("mjstats.match-entry.v2:")).length)
      await page.goto(entry)
      await score().fill("44400")
      expect(await draftCount(page)).toBe(1)
      await page.clock.setFixedTime(Date.now() + 24 * 60 * 60 * 1000 + 1000)
      await page.reload()
      await expect(score()).toHaveValue("")
      expect(await draftCount(page)).toBe(0)
      await page.clock.setFixedTime(Date.now())

      const sibling = await page.context().newPage()
      try {
        await sibling.goto(entry)
        await sibling.getByLabel("素点 1", { exact: true }).fill("55500")
        expect(await draftCount(sibling)).toBe(1)
        await score().fill("66600")
        await page.getByRole("link", { name: "アカウント" }).click()
        await logout()
        await expect(page).toHaveURL("/login")
        await expect.poll(() => draftCount(sibling)).toBe(0)
        expect(await draftCount(page)).toBe(0)
        await page.goto(entry)
        await signIn(page, owner)
        await expect(score()).toHaveValue("")
      } finally {
        await sibling.close()
      }

      await score().fill("77700")
      await page.goto(history)
      await expect(page.getByText("−55 pt", { exact: false })).toBeVisible()
      await page.context().clearCookies()
      await page.goto(entry)
      await signIn(page, member)
      await expect(score()).toHaveValue("")
      await expect(page.getByRole("button", { name: "同じ内容で再送" })).toHaveCount(0)
      expect(await draftCount(page)).toBe(0)
      await page.goBack()
      await expect(page.getByRole("heading", { name: "ゲスト記録リーグの対局履歴" })).toBeVisible()
      await expect(page.getByText("対局試験 メンバー", { exact: true }).first()).toBeVisible()
      await expect(page.getByRole("link", { name: "招待を管理" })).toHaveCount(0)
      await page.goto(`/matches/league/${b}`)
      await expect(page.getByRole("main").getByRole("alert")).toContainText("このリーグは閲覧できません。")
      await expect(page.getByText("−55 pt", { exact: false })).toHaveCount(0)
    })
  } finally {
    if (leagues.length) {
      const ids = leagues.map((id) => `'${id}'`).join(",")
      localSQL(`BEGIN;
        ${["match_revisions", "match_results", "matches", "participant_links", "league_events", "seasons", "rules", "league_members"]
          .map((table) => `DELETE FROM public.${table} WHERE league_id IN (${ids});`).join("\n")}
        DELETE FROM public.leagues WHERE id IN (${ids});
        COMMIT;`)
    }
    if (guests.length || participantIDs.length) {
      const ids = [...guests, ...participantIDs].map((id) => `'${id}'`).join(",")
      localSQL(`DELETE FROM public.users WHERE id IN (${ids});`)
    }
    for (const id of authIDs) {
      const res = await request.delete(`${cfg.API_URL}/auth/v1/admin/users/${id}`, { headers: adminHeaders })
      expect(res.ok()).toBe(true)
    }
  }
})
