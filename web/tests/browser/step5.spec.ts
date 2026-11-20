import { test, expect, type Page } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"

const container = "supabase_db_mj-stats-step1"
const api = "http://localhost:8080"

function uuid(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) throw new Error("local fixture ID")
  return value
}

function sql(input: string) {
  return execFileSync("docker", ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres",
    "-d", "postgres", "-v", "ON_ERROR_STOP=1"], { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim()
}

test("Q-15/Q-18/Q-20/Q-24/Q-26: ranking and management from league home", async ({ page, request, browser, browserName }, testInfo) => {
  test.setTimeout(180_000)
  const config = JSON.parse(readFileSync("../.local/acceptance.json", "utf8"))
  expect(config.API_URL).toBe("http://127.0.0.1:55421")
  const info = JSON.parse(execFileSync("docker", ["inspect", container], { encoding: "utf8" }))[0]
  expect(info.Config.Labels["com.supabase.cli.project"]).toBe("mj-stats-step1")
  expect(info.NetworkSettings.Ports["5432/tcp"].some((p: { HostPort: string }) => p.HostPort === "55422")).toBe(true)
  const authHeaders = { apikey: config.SERVICE_ROLE_KEY, Authorization: `Bearer ${config.SERVICE_ROLE_KEY}` }
  const authIDs: string[] = []
  const participants: string[] = []
  const groups: string[] = []

  async function person(name: string) {
    const email = `step5-${randomUUID()}@example.test`
    const password = `Qa-${randomUUID()}`
    const created = await request.post(`${config.API_URL}/auth/v1/admin/users`, {
      headers: authHeaders, data: { email, password, email_confirm: true },
    })
    expect(created.ok()).toBeTruthy()
    authIDs.push(uuid((await created.json()).id))
    const login = await request.post(`${config.API_URL}/auth/v1/token?grant_type=password`, {
      headers: { apikey: config.ANON_KEY }, data: { email, password },
    })
    expect(login.ok()).toBeTruthy()
    const headers = { Authorization: `Bearer ${(await login.json()).access_token}` }
    expect((await request.get(`${api}/api/users/me`, { headers })).ok()).toBeTruthy()
    const profile = await request.patch(`${api}/api/users/me`, { headers, data: { name } })
    expect(profile.status()).toBe(200)
    const id = uuid((await profile.json()).id)
    participants.push(id)
    return { id, email, password, headers }
  }

  async function login(target: Page, user: Awaited<ReturnType<typeof person>>) {
    await target.bringToFront()
    await target.getByLabel("メールアドレス").fill(user.email)
    await target.getByLabel("パスワード", { exact: true }).fill(user.password)
    await target.getByLabel("パスワード", { exact: true }).press("Enter")
  }

  const disposable = await browser.newContext()
  let memberPage = await disposable.newPage()
  try {
    const owner = await person("順位表 オーナー")
    const player = await person("順位表 メンバー")
    const create = await request.post(`${api}/api/leagues`, {
      headers: owner.headers, data: { name: "順位表の試験リーグ", client_request_id: randomUUID() },
    })
    expect(create.status()).toBe(201)
    const { league, rule } = await create.json()
    const id = uuid(league.id)
    groups.push(id)
    const home = `/leagues/${id}`
    const history = `/matches/league/${id}`
    const endpoint = `${api}/api${home}`
    const invite = await request.post(`${endpoint}/invites`, { headers: owner.headers, data: { client_request_id: randomUUID() } })
    expect(invite.status()).toBe(201)
    const { invite: invitation } = await invite.json()
    const join = () => request.post(`${endpoint}/join`, { headers: player.headers, data: { code: invitation.code, client_request_id: randomUUID() } })
    expect((await join()).ok()).toBeTruthy()
    const guestIDs: string[] = []
    for (const name of ["試験ゲストA", "試験ゲストB", "試験ゲストC", "試験ゲストD"]) {
      const guest = await request.post(`${endpoint}/guests`, { headers: player.headers, data: { name, client_request_id: randomUUID() } })
      expect(guest.status()).toBe(201)
      const id = uuid((await guest.json()).participant.id)
      guestIDs.push(id)
      participants.push(id)
    }
    const saved = await request.post(`${endpoint}/matches`, { headers: player.headers, data: {
      rule_id: rule.id, season_id: null, match_date: "2024-11-01T00:00:00Z", client_request_id: randomUUID(),
      players: guestIDs.map((user_id, i) => ({ user_id, raw_score: [40000, 30000, 20000, 10000][i] })),
    } })
    expect(saved.status()).toBe(201)
    const match = uuid((await saved.json()).id)
    const detail = `${history}/${match}`
    await memberPage.goto(detail + "/edit")
    await expect(memberPage).toHaveURL(`/login?returnTo=${encodeURIComponent(detail + "/edit")}`)
    await login(memberPage, player)
    await expect(memberPage).toHaveURL(detail + "/edit")
    await expect(memberPage.getByRole("main").getByRole("alert")).toContainText("閲覧する権限がありません")
    await memberPage.goto(home + "/settings")
    await expect(memberPage.getByRole("main").getByRole("alert")).toContainText("閲覧する権限がありません")
    await memberPage.goto(detail)
    await expect(memberPage.getByRole("heading", { name: "対局詳細", exact: true })).toBeVisible()
    await expect(memberPage.getByRole("link", { name: "訂正・取消" })).toHaveCount(0)
    await memberPage.close()

    await page.bringToFront()
    await page.goto(home)
    await login(page, owner)
    await expect(page).toHaveURL(home)
    await page.getByRole("link", { name: "順位表", exact: true }).press("Enter")
    await expect(page.getByText("1位 試験ゲストA（ゲスト）")).toBeVisible()
    await expect(page.getByText("+50 pt · 1対局")).toBeVisible()
    await page.getByRole("link", { name: "対局履歴", exact: true }).click()
    await expect(page).toHaveURL(history)
    await expect(page.getByRole("heading", { name: "順位表の試験リーグの対局履歴" })).toBeVisible()
    await page.getByRole("link", { name: "対局詳細" }).click()
    await expect(page).toHaveURL(detail)
    await page.getByRole("link", { name: "訂正・取消" }).click()
    await expect(page).toHaveURL(detail + "/edit")
    await expect(page.getByRole("heading", { name: "対局の訂正・取消" })).toBeVisible()
    await page.setViewportSize({ width: 360, height: 800 })
    await page.locator("html").evaluate((el) => el.style.fontSize = "200%")
    await page.screenshot({ path: testInfo.outputPath("edit-360-text200.png"), fullPage: true })
    const overflows = await page.evaluate(() =>
      [...document.querySelectorAll("*")].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
        .map((el) => [el.tagName, el.getAttribute("class")]).slice(0, 15))
    expect(overflows).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await expect(page.getByLabel("対局日（日本時間）")).toBeVisible()
    await expect(page.getByLabel("開始時刻（日本時間）")).toBeVisible()
    await page.locator("html").evaluate((el) => el.style.removeProperty("font-size"))
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByLabel("素点 1（点）", { exact: true }).fill("35000")
    await page.getByLabel("素点 2（点）", { exact: true }).fill("35000")
    await page.getByLabel("訂正理由").fill("対局表で素点を確認")

    let appliedBody: string | null = null
    await page.route(`${endpoint}/matches/${match}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue()
      appliedBody = route.request().postData()
      expect((await route.fetch()).status()).toBe(200)
      await route.abort("connectionreset")
    })
    await page.getByRole("button", { name: "訂正を保存" }).click()
    await expect(page.getByRole("main").getByRole("alert")).toContainText("同じ操作を再試行")
    await page.unroute(`${endpoint}/matches/${match}`)
    const retry = page.waitForResponse((res) => res.request().method() === "PATCH" && res.url().endsWith(match))
    await page.getByRole("button", { name: "同じ操作を再試行" }).click()
    expect((await retry).request().postData()).toBe(appliedBody)
    await expect(page).toHaveURL(detail)
    await expect(page.getByText("訂正済み", { exact: true })).toBeVisible()
    await page.getByRole("link", { name: "変更履歴" }).click()
    await expect(page.getByText("理由 対局表で素点を確認")).toBeVisible()
    await page.getByText("変更前", { exact: true }).click()
    await expect(page.getByText("40,000点", { exact: false }).filter({ visible: true })).toBeVisible()
    await page.goto(home + "/ranking")
    await expect(page.getByText("+30 pt · 1対局")).toHaveCount(2)
    await expect(page.getByText("3位 試験ゲストC（ゲスト）")).toBeVisible()

    await page.getByRole("link", { name: "リーグホーム" }).click()
    await page.getByRole("link", { name: "ゲストの本人紐付け" }).click()
    await page.getByRole("combobox", { name: "ゲスト", exact: true }).selectOption(guestIDs[0])
    await page.getByRole("checkbox").check()
    await page.getByRole("button", { name: "本人として申請" }).click()
    await page.getByRole("button", { name: "申請を確認" }).click()
    await page.getByLabel("確認内容").fill("同卓者が確認した")
    await page.getByRole("button", { name: "承認", exact: true }).click()
    await expect(page.getByText("承認済み", { exact: true })).toBeVisible()
    await page.getByRole("link", { name: "対局履歴へ", exact: true }).click()
    await page.getByRole("link", { name: "対局を入力", exact: true }).click()
    const choices = page.getByRole("combobox", { name: "参加者 1", exact: true })
    await expect(choices.locator(`option[value="${owner.id}"]`)).toHaveCount(1)
    await expect(choices.locator(`option[value="${guestIDs[0]}"]`)).toHaveCount(0)
    await page.getByRole("link", { name: "対局履歴", exact: true }).click()
    await page.getByRole("link", { name: "対局詳細" }).click()
    await page.getByRole("link", { name: "訂正・取消" }).click()
    const retainedGuest = page.getByRole("group", { name: "訂正内容" })
      .locator(`select option[value="${guestIDs[0]}"]:checked`)
    await expect(retainedGuest).toHaveText("順位表 オーナー（記録済みの参加者）")
    await page.goto(home + "/ranking")
    await expect(page.getByText("1位 順位表 オーナー", { exact: true })).toBeVisible()
    await page.goto(history + "/participant-links")
    await page.getByRole("button", { name: "紐付け解除", exact: true }).click()
    await page.getByLabel("解除理由").fill("紐付け先を見直した")
    await page.getByRole("button", { name: "本人紐付けを解除する" }).click()
    await expect(page.getByText("解除済み", { exact: true })).toBeVisible()
    await page.goto(home + "/ranking")
    await expect(page.getByText("1位 試験ゲストA（ゲスト）")).toBeVisible()

    await page.goto(detail + "/edit")
    await page.getByRole("button", { name: "取消", exact: true }).click()
    await page.getByLabel("取消理由").fill("重複対局を取り消す")
    await page.getByLabel("この対局を取り消すことを確認しました").check()
    await page.getByRole("button", { name: "対局を取り消す" }).click()
    await expect(page).toHaveURL(detail)
    await expect(page.getByText("取消済み · 順位表の集計対象外")).toBeVisible()
    await page.getByRole("link", { name: "順位表", exact: true }).click()
    await expect(page.getByText("この範囲に成績はありません。")).toBeVisible()
    expect(sql(`SELECT count(*),(SELECT count(*) FROM public.match_revisions WHERE match_id='${match}')
      FROM public.match_results WHERE match_id='${match}';`)).toBe("4|3")

    await page.goto(home)
    await page.getByRole("link", { name: "リーグ設定" }).click()
    await page.getByLabel("名前検索に掲載する").check()
    await page.getByRole("button", { name: "リーグ設定を保存" }).click()
    await expect.poll(() => sql(`SELECT search_listed FROM public.leagues WHERE id='${id}'`)).toBe("t")
    await test.step("stop, reload and resume the rule in settings, then check the entry choices", async () => {
      const ruleRow = page.getByRole("listitem").filter({ hasText: rule.name })
      await ruleRow.getByRole("button", { name: "利用を停止" }).click()
      await expect(ruleRow.getByRole("button", { name: "利用を再開" })).toBeVisible()
      await page.reload()
      await expect(ruleRow.getByRole("button", { name: "利用を再開" })).toBeVisible()
      await page.getByRole("link", { name: "リーグホーム" }).click()
      await page.getByRole("link", { name: "対局を入力", exact: true }).click()
      const ruleSelect = page.getByRole("combobox", { name: "ルール", exact: true })
      const ruleOption = ruleSelect.locator(`option[value="${rule.id}"]`)
      await expect(page.getByRole("heading", { name: "順位表の試験リーグの対局入力" })).toBeVisible()
      await expect(ruleSelect).toBeVisible()
      await expect(ruleOption).toHaveCount(0)
      await page.getByRole("link", { name: "リーグホーム" }).click()
      await page.getByRole("link", { name: "リーグ設定" }).click()
      await ruleRow.getByRole("button", { name: "利用を再開" }).click()
      await expect(ruleRow.getByRole("button", { name: "利用を停止" })).toBeVisible()
      await page.getByRole("link", { name: "リーグホーム" }).click()
      await page.getByRole("link", { name: "対局を入力", exact: true }).click()
      await expect(ruleOption).toHaveText(rule.name)
      await page.getByRole("link", { name: "リーグホーム" }).click()
      await page.getByRole("link", { name: "リーグ設定" }).click()
    })
    await page.getByRole("link", { name: "操作記録" }).click()
    await expect(page.getByRole("heading", { name: "リーグ設定", exact: true })).toBeVisible()
    await page.goto(home + "/settings")
    await page.getByRole("combobox", { name: "引継ぎ相手", exact: true }).selectOption(player.id)
    await page.getByRole("button", { name: "引継ぎ相手を指名" }).click()
    await expect(page.getByText("順位表 メンバー の同意を待っています。")).toBeVisible()
    memberPage = await disposable.newPage()
    await memberPage.bringToFront()
    await memberPage.goto(home)
    await memberPage.getByLabel("このリーグのオーナーを引き継ぐことに同意します").check()
    await memberPage.getByRole("button", { name: "同意して引き継ぐ" }).click()
    await expect(memberPage.getByText("オーナー", { exact: true })).toBeVisible()

    await page.bringToFront()
    await page.goto(home)
    await page.getByText("リーグから脱退", { exact: true }).click()
    await page.getByLabel("脱退することを確認しました").check()
    await page.getByRole("button", { name: "脱退する", exact: true }).click()
    await expect(page).toHaveURL("/")
    const rejoin = await request.post(`${endpoint}/join`, { headers: owner.headers, data: { code: invitation.code, client_request_id: randomUUID() } })
    expect(rejoin.ok()).toBeTruthy()
    expect((await rejoin.json()).membership.role).toBe("member")

    const touch = await browser.newContext({ storageState: await memberPage.context().storageState(), isMobile: true, hasTouch: true,
      viewport: { width: 360, height: 800 } })
    try {
      const phone = await touch.newPage()
      await phone.goto(home)
      await phone.getByRole("link", { name: "順位表", exact: true }).tap()
      await expect(phone).toHaveURL(home + "/ranking")
      await expect(phone.getByRole("heading", { name: "順位表", exact: true })).toBeVisible()
      for (const [width, height] of [[360, 800], [390, 844], [768, 1024], [1280, 900], [844, 390]]) {
        await phone.setViewportSize({ width, height })
        for (const path of [home + "/ranking", home + "/settings"]) {
          await phone.goto(path)
          await expect(phone.getByRole("heading", { name: path.endsWith("/ranking") ? "順位表" : "リーグ設定", exact: true })).toBeVisible()
          await phone.locator("html").evaluate((el) => el.style.fontSize = "200%")
          expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${browserName} overflow at ${width} ${path.split("/").at(-1)}`).toBe(true)
          if (width === 360) await phone.screenshot({ path: testInfo.outputPath(`${path.split("/").at(-1)}-360-text200.png`), fullPage: true })
        }
      }
    } finally {
      await touch.close()
    }
    await memberPage.goto(home + "/ranking")
    await memberPage.getByRole("link", { name: "順位表", exact: true }).focus()
    await memberPage.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab")
    await expect(memberPage.getByLabel("対象シーズン")).toBeFocused()
  } finally {
    await disposable.close()
    if (groups.length) {
      const list = groups.map((value) => `'${value}'`).join(",")
      const tables = ["match_revisions", "match_results", "matches", "participant_links", "league_events", "owner_transfers", "league_invites", "seasons", "rules", "league_members"]
      sql(`BEGIN; ${tables.map((table) => `DELETE FROM public.${table} WHERE league_id IN (${list});`).join("\n")}
        DELETE FROM public.leagues WHERE id IN (${list}); COMMIT;`)
    }
    if (participants.length) sql(`DELETE FROM public.users WHERE id IN (${participants.map((id) => `'${id}'`).join(",")});`)
    for (const id of authIDs) {
      await request.delete(`${config.API_URL}/auth/v1/admin/users/${id}`, { headers: authHeaders })
    }
  }
})
