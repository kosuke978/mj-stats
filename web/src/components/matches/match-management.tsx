"use client"

import { useRouter } from "next/navigation"
import { useState, type FormEvent } from "react"
import { useLeagueAction, type Post } from "@/components/leagues/league-api"
import { Button } from "@/components/ui/button"
import type { MatchHistory, MatchRule, Participant, Season } from "@/types/match"
import { participantLabel } from "./participant-label"
import { ResultList } from "./result-list"

const field = "min-h-11 w-full min-w-0 rounded-md border bg-background px-2 py-1.5"

function tokyoDate(value: string | null) {
  return value ? new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 19) : ""
}

export function MatchManagement({ match, rules, seasons, participants, detail }: {
  match: MatchHistory; rules: MatchRule[]; seasons: Season[]; participants: Participant[]; detail: string
}) {
  const router = useRouter()
  const action = useLeagueAction()
  const [mode, setMode] = useState<"edit" | "cancel">("edit")
  const [conflict, setConflict] = useState(false)
  const originalDate = tokyoDate(match.match_date)
  const path = `/api/leagues/${match.league_id}/matches/${match.id}`
  const disabled = action.busy || action.retry || conflict

  async function send(post: Post | null) {
    const result = await action.run(post, (code) => {
      if (["VERSION_CONFLICT", "STATE_CONFLICT", "FORBIDDEN", "LEAGUE_ACCESS_DENIED"].includes(code)) setConflict(true)
    })
    if (result) {
      router.replace(detail)
      router.refresh()
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const meta = { reason: String(form.get("reason")), version: match.version, client_request_id: crypto.randomUUID() }
    if (mode === "cancel") {
      void send({ path: `${path}/cancel`, body: meta })
      return
    }
    const time = String(form.get("match_time"))
    const date = `${form.get("match_day")}T${time.length === 5 ? `${time}:00` : time}`
    const players = match.results.map((_, i) => ({
      user_id: String(form.get(`player-${i}`)),
      raw_score: Number(form.get(`score-${i}`)),
    }))
    void send({ path, method: "PATCH", body: {
      ...meta, rule_id: form.get("rule_id"), season_id: form.get("season_id") || null,
      match_date: date === originalDate ? match.match_date : `${date}+09:00`, players,
    } })
  }

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <h2 className="font-semibold">現在の結果（版 {match.version}）</h2>
        <ResultList results={match.results} />
      </section>
      <div className="flex flex-wrap gap-2">
        <Button className="min-h-11" variant={mode === "edit" ? "default" : "outline"} aria-pressed={mode === "edit"} disabled={disabled} onClick={() => setMode("edit")}>訂正</Button>
        <Button className="min-h-11" variant={mode === "cancel" ? "destructive" : "outline"} aria-pressed={mode === "cancel"} disabled={disabled} onClick={() => setMode("cancel")}>取消</Button>
      </div>
      <form key={mode} onSubmit={submit}>
        <fieldset disabled={disabled} className="grid min-w-0 gap-3 rounded-lg border p-3">
          <legend className="px-1 font-semibold">{mode === "edit" ? "訂正内容" : "取消内容"}</legend>
          {mode === "edit" ? <>
            <label className="grid gap-1">ルール<select name="rule_id" required defaultValue={match.rule_id} className={field}>
              {rules.filter((r) => r.available || r.id === match.rule_id).map((r) => <option key={r.id} value={r.id}>{r.name}{!r.available && "（利用停止）"}</option>)}
            </select></label>
            <label className="grid gap-1">シーズン<select name="season_id" defaultValue={match.season_id ?? ""} className={field}>
              <option value="">未指定</option>
              {seasons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></label>
            <label className="grid min-w-0 gap-1">対局日（日本時間）
              <input type="date" name="match_day" required defaultValue={originalDate.slice(0, 10)} className={field} />
            </label>
            <label className="grid min-w-0 gap-1">開始時刻（日本時間）
              <input type="time" name="match_time" required step="1" defaultValue={originalDate.slice(11)} className="min-h-11 w-full min-w-0 rounded-md border bg-background px-1.5 py-1.5 text-sm sm:text-base" />
            </label>
            {match.results.map((row, i) => (
              <div key={row.user_id} className="grid min-w-0 gap-2 sm:grid-cols-2">
                <label className="grid min-w-0 gap-1">参加者 {i + 1}<select name={`player-${i}`} defaultValue={row.user_id} required className={field}>
                  {!participants.some((p) => p.id === row.user_id) &&
                    <option value={row.user_id}>{row.display_name}（記録済みの参加者）</option>}
                  {participants.map((p) => <option key={p.id} value={p.id}>{participantLabel(p, participants)}</option>)}
                </select></label>
                <label className="grid min-w-0 gap-1">素点 {i + 1}（点）
                  <input type="number" name={`score-${i}`} required step={100} defaultValue={row.raw_score} className={field} />
                </label>
              </div>
            ))}
          </> : <p>取消後は対局が順位表の集計対象から外れます。対局履歴と結果は残ります。</p>}
          <label className="grid gap-1">{mode === "edit" ? "訂正理由" : "取消理由"}
            <textarea name="reason" required maxLength={500} className={field + " min-h-20"} />
          </label>
          {mode === "cancel" && <label className="flex items-start gap-2"><input type="checkbox" required className="mt-1" />この対局を取り消すことを確認しました</label>}
          <Button type="submit" variant={mode === "cancel" ? "destructive" : "default"} className="min-h-11 justify-self-start">
            {action.busy ? "送信中…" : mode === "edit" ? "訂正を保存" : "対局を取り消す"}
          </Button>
        </fieldset>
      </form>
      {action.message && <p role="alert">{action.message}</p>}
      {conflict && <Button className="min-h-11" variant="outline" onClick={() => window.location.reload()}>最新の状態を確認</Button>}
      {action.retry && <Button className="min-h-11" onClick={() => void send(null)} disabled={action.busy}>同じ操作を再試行</Button>}
    </div>
  )
}
