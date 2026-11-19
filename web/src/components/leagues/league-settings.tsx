"use client"

import type { ReactNode } from "react"
import { ManagementForm, managementField, type OwnerTransfer } from "@/components/leagues/league-management-forms"
import { leagueRoles } from "@/lib/leagues/paths"
import type { League, MatchRule, Participant, Season } from "@/types/match"

export type Settings = { id: string; name: string; search_listed: boolean; version: string }
export type Member = { user_id: string; name: string; kind: Participant["kind"]; role: League["my_role"]; status: "active" | "left" | "removed"; version: string }

const text = (data: FormData, field: string) => String(data.get(field) ?? "")

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="min-w-0 space-y-3 rounded-lg border p-4"><h2 className="text-lg font-semibold">{title}</h2>{children}</section>
}

function SeasonForm({ endpoint, season }: { endpoint: string; season?: Season }) {
  return <ManagementForm path={`${endpoint}/seasons${season ? `/${season.id}` : ""}`} method={season && "PATCH"}
    label={season ? "シーズンを更新" : "シーズンを作成"}
    payload={(data) => ({
      name: text(data, "name"), start_date: text(data, "start_date") || null, end_date: text(data, "end_date") || null,
      ...(season && { version: season.version }),
    })}>
    <label className="grid gap-1">シーズン名<input name="name" required maxLength={100} defaultValue={season?.name} className={managementField} /></label>
    <label className="grid min-w-0 gap-1">開始日（任意）<input name="start_date" type="date" defaultValue={season?.start_date ?? ""} className={managementField} /></label>
    <label className="grid min-w-0 gap-1">終了日（任意）<input name="end_date" type="date" defaultValue={season?.end_date ?? ""} className={managementField} /></label>
  </ManagementForm>
}

export function LeagueSettings({ league, settings, members, rules, seasons, guests, transfer }: {
  league: League; settings: Settings; members: Member[]; rules: MatchRule[]; seasons: Season[]; guests: Participant[]; transfer: OwnerTransfer | null
}) {
  const endpoint = `/api/leagues/${league.id}`
  const owner = league.my_role === "owner"
  const nominees = members.filter((m) => m.kind === "registered" && m.status === "active" && m.role !== "owner")
  const memberName = (id: string) => members.find((m) => m.user_id === id)?.name ?? id
  return <div className="space-y-4">
    <SettingsSection title="リーグ名と検索掲載">
      <ManagementForm key={settings.version} path={`${endpoint}/settings`} method="PATCH" label="リーグ設定を保存"
        payload={(data) => ({ name: text(data, "name"), search_listed: data.has("listed"), version: settings.version })}>
        <label className="grid gap-1">リーグ名<input name="name" required maxLength={100} defaultValue={settings.name} className={managementField} /></label>
        <label className="flex items-start gap-2"><input type="checkbox" name="listed" defaultChecked={settings.search_listed} className="mt-1" />名前検索に掲載する</label>
      </ManagementForm>
    </SettingsSection>
    <SettingsSection title="所属と権限">
      <ul className="divide-y">
        {members.filter((m) => m.kind === "registered").map((m) => {
          const active = m.status === "active" && m.role !== "owner"
          return <li key={`${m.user_id}/${m.version}`} className="space-y-2 py-3">
            <p className="wrap-anywhere">{m.name} ({m.user_id.slice(0, 8)}) · {leagueRoles[m.role]}
              {m.status === "left" && " · 脱退済み"}{m.status === "removed" && " · 除名済み"}</p>
            {owner && active && <ManagementForm path={`${endpoint}/members/${m.user_id}`} method="PATCH" label="権限を変更"
              payload={(data) => ({ role: text(data, "role"), version: m.version })}>
              <label className="grid gap-1">変更後の権限
                <select name="role" className={managementField} defaultValue={m.role}>
                  <option value="member">メンバー</option><option value="admin">管理者</option>
                </select>
              </label>
            </ManagementForm>}
            {active && (owner || m.role === "member") && <details>
              <summary className="min-h-11 cursor-pointer py-2">除名</summary>
              <ManagementForm path={`${endpoint}/members/${m.user_id}/remove`} label="このメンバーを除名" destructive
                payload={(data) => ({ reason: text(data, "reason"), version: m.version })}>
                <label className="grid gap-1">除名理由<textarea name="reason" required maxLength={500} className={managementField} /></label>
              </ManagementForm>
            </details>}
          </li>
        })}
      </ul>
    </SettingsSection>
    <SettingsSection title="オーナー引継ぎ">
      {transfer?.status === "pending" ? <>
        <p className="wrap-anywhere">{memberName(transfer.to_user_id)} の同意を待っています。</p>
        {owner && <ManagementForm path={`${endpoint}/owner-transfers/${transfer.id}/cancel`} label="指名を取り消す"
          payload={() => ({ version: transfer.version })} />}
      </> : owner ? (
        <>
          {transfer?.status === "expired" && <p>前回の指名は期限切れです。</p>}
          {nominees.length ? <ManagementForm path={`${endpoint}/owner-transfers`} label="引継ぎ相手を指名"
            payload={(data) => ({ to_user_id: text(data, "nominee") })}>
            <label className="grid gap-1">引継ぎ相手
              <select name="nominee" required defaultValue="" className={managementField}>
                <option value="">選択してください</option>
                {nominees.map((m) => <option key={m.user_id} value={m.user_id}>{m.name} ({m.user_id.slice(0, 8)})</option>)}
              </select>
            </label>
            <p className="text-sm">指名から7日以内に、相手本人がリーグホームで同意すると引継ぎが完了します。</p>
          </ManagementForm> : <p>現在指名できるメンバーはいません。</p>}
        </>
      ) : <p>承認待ちの引継ぎはありません。</p>}
    </SettingsSection>
    <SettingsSection title="ルール">
      <ul className="divide-y">
        {rules.map((rule) => <li key={`${rule.id}/${rule.version}`} className="space-y-2 py-3">
          <p className="wrap-anywhere">{rule.name} · {rule.available ? "利用可" : "利用停止"}</p>
          <p className="text-sm wrap-anywhere">{rule.default_points}点持ち / {rule.return_points}点返し · ウマ {rule.uma.join(" / ")}</p>
          <ManagementForm path={`${endpoint}/rules/${rule.id}`} method="PATCH" label={rule.available ? "利用を停止" : "利用を再開"}
            payload={() => ({ available: !rule.available, version: rule.version })} />
        </li>)}
      </ul>
      <details>
        <summary className="min-h-11 cursor-pointer py-2 font-medium">ルールの新版を作成</summary>
        <ManagementForm path={`${endpoint}/rules`} label="新版を作成"
          payload={(data) => ({ name: text(data, "name"), default_points: Number(data.get("start")), return_points: Number(data.get("return")), uma: [1, 2, 3, 4].map((rank) => Number(data.get(`uma${rank}`))) })}>
          <label className="grid gap-1">新版の名前<input name="name" required maxLength={100} className={managementField} /></label>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="grid gap-1">開始時の持ち点<input name="start" type="number" min={100} step={100} defaultValue={25000} required className={managementField} /></label>
            <label className="grid gap-1">返し点<input name="return" type="number" min={100} step={100} defaultValue={30000} required className={managementField} /></label>
            {[20, 10, -10, -20].map((value, i) => <label key={i} className="grid gap-1">{i + 1}位のウマ（pt）
              <input name={`uma${i + 1}`} type="number" step={1} defaultValue={value} required className={managementField} />
            </label>)}
          </div>
        </ManagementForm>
      </details>
    </SettingsSection>
    <SettingsSection title="シーズン">
      {seasons.map((season) => <details key={`${season.id}/${season.version}`}>
        <summary className="min-h-11 cursor-pointer py-2 wrap-anywhere">{season.name}</summary>
        <SeasonForm endpoint={endpoint} season={season} />
      </details>)}
      <details>
        <summary className="min-h-11 cursor-pointer py-2 font-medium">シーズンを追加</summary>
        <SeasonForm endpoint={endpoint} />
      </details>
    </SettingsSection>
    <SettingsSection title="未紐付けゲスト">
      {guests.length === 0 && <p>名前を変更できるゲストはありません。</p>}
      {guests.map((guest) => <details key={`${guest.id}/${guest.version}`}>
        <summary className="min-h-11 cursor-pointer py-2 wrap-anywhere">{guest.name} ({guest.id.slice(0, 8)})</summary>
        <ManagementForm path={`${endpoint}/guests/${guest.id}`} method="PATCH" label="ゲスト名を変更"
          payload={(data) => ({ name: text(data, "name"), version: guest.version })}>
          <label className="grid gap-1">ゲスト名<input name="name" required maxLength={30} defaultValue={guest.name} className={managementField} /></label>
        </ManagementForm>
      </details>)}
    </SettingsSection>
  </div>
}
