import { test, expect, type Page } from "@playwright/test"
import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"

const container = "supabase_db_mj-stats-step1"
const api = "http://localhost:8080"

function localSQL(input: string) {
  return execFileSync("docker", ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres",
    "-d", "postgres", "-v", "ON_ERROR_STOP=1"], {
    input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  }).trim()
}

test("Step 3: real guest entry, exact history and recovery after a lost save response", async ({ page, request }) => {
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
    await page.goto(history)
    await signIn(page, owner)
    await expect(page).toHaveURL(history)
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
    await page.getByLabel("対局日時（日本時間）").fill("2024-11-01T00:00")
    await expect(page.getByLabel("シーズン")).toHaveValue("")
    await page.getByRole("button", { name: "計算する" }).click()
    await expect(page.getByRole("main").getByRole("alert")).toContainText("100点単位")
    await expect(page.getByLabel("素点 4", { exact: true })).toHaveValue("101")
    await page.getByLabel("素点 4", { exact: true }).fill(scores[3])

    await page.goto(`/matches/league/${b}/new`)
    await expect(page.getByLabel("素点 1", { exact: true })).toHaveValue("")
    await expect(page.getByRole("option", { name: /同名ゲスト/ })).toHaveCount(0)
    await page.goto(entry)
    await expect(page.getByRole("combobox", { name: "参加者 1", exact: true })).toHaveValue(guests[0])
    await expect(page.getByLabel("素点 1", { exact: true })).toHaveValue("33300")
    await page.getByRole("button", { name: "計算する" }).click()
    await expect(page.getByText("+16.6333… pt", { exact: false })).toHaveCount(3)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    let originalBody: unknown
    let matchID = ""
    await page.route(saveURL, async (route) => {
      if (route.request().method() !== "POST") return route.continue()
      originalBody = route.request().postDataJSON()
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

    await page.getByRole("link", { name: "アカウント" }).click()
    await page.getByRole("button", { name: "このブラウザからログアウト" }).click()
    await expect(page).toHaveURL(/\/login/)
    await page.goto(entry)
    await signIn(page, member)
    await expect(page).toHaveURL(entry)
    await expect(page.getByLabel("素点 1", { exact: true })).toHaveValue("")
    await expect(page.getByRole("button", { name: "同じ内容で再送" })).toHaveCount(0)
    await page.getByRole("link", { name: "アカウント" }).click()
    await page.getByRole("button", { name: "このブラウザからログアウト" }).click()
    await expect(page).toHaveURL(/\/login/)
    await page.goto(entry)
    await signIn(page, owner)
    await expect(page).toHaveURL(entry)
    await expect(page.getByRole("button", { name: "同じ内容で再送" })).toBeVisible()
    await page.route(saveURL, async (route) => {
      if (route.request().method() !== "POST") return route.continue()
      expect(route.request().postDataJSON()).toEqual(originalBody)
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
    await page.getByRole("link", { name: "保存した対局を見る" }).click()
    await expect(page).toHaveURL(`${history}/${matchID}`)
    await expect(page.getByText("+16.6333… pt", { exact: false })).toHaveCount(3)
    await page.getByText("正確な値と参加者ID").first().click()
    await expect(page.getByText("499/30 pt", { exact: true }).filter({ visible: true })).toHaveCount(1)
    await expect(page.getByText("未指定", { exact: true })).toBeVisible()

    await page.getByRole("link", { name: "対局履歴へ" }).click()
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

    await page.getByRole("link", { name: "対局履歴へ" }).click()
    await page.getByRole("link", { name: "対局を入力" }).click()
    await expect(page.getByLabel("素点 1", { exact: true })).toHaveValue("")
    const nextScores = ["60000", "30000", "15000", "-5000"]
    const nextPlayers = [...guests.slice(0, 3), member.id]
    for (let i = 0; i < nextPlayers.length; i++) {
      await page.getByRole("combobox", { name: `参加者 ${i + 1}`, exact: true }).selectOption(nextPlayers[i])
      await page.getByLabel(`素点 ${i + 1}`, { exact: true }).fill(nextScores[i])
    }
    await page.getByLabel("対局日時（日本時間）").fill("2024-11-02T00:00")
    await page.getByRole("button", { name: "計算する" }).click()
    await expect(page.getByText("−55 pt", { exact: false })).toBeVisible()
    await page.getByRole("button", { name: "保存する" }).click()
    await page.getByRole("link", { name: "保存した対局を見る" }).click()
    await expect(page.getByText("−55 pt", { exact: false })).toBeVisible()
    expect(localSQL(`SELECT count(DISTINCT match_id) FROM public.match_results WHERE league_id='${a}' AND user_id='${guests[0]}'`)).toBe("2")
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
