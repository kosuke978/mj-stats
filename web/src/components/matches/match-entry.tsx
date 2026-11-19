"use client"

import { AppLink } from "@/components/navigation/app-link"
import { useRef, useState, useSyncExternalStore } from "react"
import { useViewer } from "@/components/auth/viewer-provider"
import { leagueMessage, useLeagueAction } from "@/components/leagues/league-api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { APIError } from "@/lib/auth/api"
import { clientAPI } from "@/lib/auth/client-api"
import type { MatchHistory, MatchHistoryResult, MatchRule, MatchSaveInput, MatchScores, Participant, Season } from "@/types/match"
import { participantLabel } from "./participant-label"
import { ResultList } from "./result-list"

type Draft = {
  rule: string
  season: string
  date: string
  players: { id: string; score: string }[]
  pending: MatchSaveInput | null
}

type ReferenceData = {
  leagueID: string
  participants: Participant[]
  rules: MatchRule[]
  seasons: Season[]
}

const subscribe = () => () => {}
const clientMounted = () => true
const serverMounted = () => false
const rejectedSaveCodes = new Set([
  "INVALID_INPUT", "NOT_FOUND", "STATE_CONFLICT", "IDEMPOTENCY_CONFLICT",
  "PAYLOAD_TOO_LARGE", "UNSUPPORTED_MEDIA_TYPE",
])
const selectStyle = "h-10 w-full min-w-0 rounded-md border bg-background px-2"

export function MatchEntry(props: ReferenceData) {
  const { viewer, subject } = useViewer()
  const mounted = useSyncExternalStore(subscribe, clientMounted, serverMounted)
  const storageKey = `mjstats.match-entry.v1:${subject}:${viewer.id}:${props.leagueID}`
  if (!mounted) return <p role="status">入力画面を読み込んでいます…</p>
  return <EntryForm key={storageKey} storageKey={storageKey} subject={subject} {...props} />
}

function newDraft(rules: MatchRule[]): Draft {
  const time = new Date(Date.now() + 9 * 60 * 60 * 1000)
  return {
    rule: rules.length === 1 ? rules[0].id : "",
    season: "",
    date: time.toISOString().slice(0, 16),
    players: Array.from({ length: 4 }, () => ({ id: "", score: "" })),
    pending: null,
  }
}

function readDraft(key: string, rules: MatchRule[]): Draft {
  try {
    const stored = window.sessionStorage.getItem(key)
    if (stored) {
      const draft = JSON.parse(stored) as Draft
      if (draft.players.length === 4) return draft
    }
  } catch {
    // The current form remains available if browser storage is disabled.
  }
  return newDraft(rules)
}

function EntryForm({ leagueID, participants: initial, rules, seasons, storageKey, subject }: ReferenceData & {
  storageKey: string
  subject: string
}) {
  const [participants, setParticipants] = useState(initial)
  const [draft, setDraft] = useState(() => readDraft(storageKey, rules))
  const [guestName, setGuestName] = useState("")
  const [guestNotice, setGuestNotice] = useState("")
  const [preview, setPreview] = useState<{ scores: MatchScores; results: MatchHistoryResult[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [saved, setSaved] = useState<MatchHistory | null>(null)
  const running = useRef(false)
  const guest = useLeagueAction()
  const base = `/api/leagues/${leagueID}`
  const history = `/matches/league/${leagueID}`
  const rule = rules.find((r) => r.id === draft.rule)
  const expectedTotal = rule ? rule.default_points * 4 : null
  const total = draft.players.reduce((sum, p) => sum + (Number(p.score) || 0), 0)
  const locked = busy || draft.pending !== null

  function store(next: Draft) {
    setDraft(next)
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify(next))
    } catch {
      // The retry snapshot is also kept in memory for this page.
    }
  }

  function edit(fields: Partial<Draft>) {
    store({ ...draft, ...fields })
    setPreview(null)
    setMessage("")
  }

  function editPlayer(index: number, fields: { id?: string; score?: string }) {
    edit({ players: draft.players.map((p, i) => i === index ? { ...p, ...fields } : p) })
  }

  async function createGuest() {
    const result = await guest.run<{ participant: Participant }>(guest.retry ? null : {
      path: `${base}/guests`,
      body: { name: guestName, client_request_id: crypto.randomUUID() },
    })
    if (!result) return
    setParticipants((all) => all.some((p) => p.id === result.participant.id) ? all : [...all, result.participant])
    setGuestName("")
    setGuestNotice(`${result.participant.name}を候補に追加しました。`)
  }

  async function calculate() {
    if (running.current || draft.pending) return
    setPreview(null)
    const chosen = draft.players.map((p) => p.id)
    if (!draft.rule || chosen.some((id) => !id) || new Set(chosen).size !== 4) {
      setMessage("ルールと異なる参加者4人を選んでください。")
      return
    }
    if (draft.players.some(({ score }) => {
      const value = Number(score)
      return !/^-?\d+$/.test(score.trim()) || value < -2147483648 || value > 2147483647 || value % 100 !== 0
    })) {
      setMessage("各参加者の素点を100点単位で入力してください。")
      return
    }
    const scores: MatchScores = {
      rule_id: draft.rule,
      players: draft.players.map((p) => ({ user_id: p.id, raw_score: Number(p.score) })),
    }
    running.current = true
    setBusy(true)
    setMessage("")
    try {
      const value = await clientAPI<{ results: MatchHistoryResult[] }>(`${base}/matches/calculate`, {
        method: "POST", body: JSON.stringify(scores), signal: AbortSignal.timeout(15000),
      }, subject)
      setPreview({ scores, results: value.results })
    } catch (error) {
      setMessage(leagueMessage(error))
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  async function save() {
    if (running.current) return
    let input = draft.pending
    if (!input) {
      if (!preview) return
      if (!draft.date) {
        setMessage("日本時間で対局日時を入力してください。")
        return
      }
      const date = draft.date.length === 16 ? `${draft.date}:00` : draft.date
      input = {
        ...preview.scores, season_id: draft.season || null, match_date: `${date}+09:00`,
        client_request_id: crypto.randomUUID(),
      }
    }
    running.current = true
    setBusy(true)
    setMessage("")
    store({ ...draft, pending: input })
    try {
      const value = await clientAPI<MatchHistory>(`${base}/matches`, {
        method: "POST", body: JSON.stringify(input), signal: AbortSignal.timeout(15000),
      }, subject)
      store(newDraft(rules))
      try { window.sessionStorage.removeItem(storageKey) } catch {}
      setPreview(null)
      setSaved(value)
    } catch (error) {
      const rejected = error instanceof APIError && rejectedSaveCodes.has(error.code)
      if (rejected) {
        store({ ...draft, pending: null })
        setMessage(leagueMessage(error))
      } else {
        setMessage("保存結果を確認できません。同じ内容で再送してください。")
      }
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  if (saved) return (
    <section className="space-y-4 rounded-lg border p-4">
      <p role="status">対局を保存しました。</p>
      <div className="flex flex-wrap items-center gap-4">
        <AppLink className="underline" href={`${history}/${saved.id}`}>保存した対局を見る</AppLink>
        <Button variant="outline" onClick={() => setSaved(null)}>次の対局を入力</Button>
      </div>
    </section>
  )

  return (
    <div className="space-y-5">
      <fieldset disabled={locked} className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
        <legend className="px-1 font-medium">対局の条件</legend>
        <label className="grid gap-1 text-sm">
          ルール
          <select className={selectStyle} value={draft.rule} onChange={(e) => edit({ rule: e.target.value })}>
            <option value="">ルールを選択</option>
            {draft.rule && !rule && <option value={draft.rule}>利用できないルール</option>}
            {rules.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.default_points.toLocaleString("ja-JP")}点持ち · {r.id.slice(0, 8)}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          シーズン
          <select className={selectStyle} value={draft.season} onChange={(e) => edit({ season: e.target.value })}>
            <option value="">未指定</option>
            {draft.season && !seasons.some((s) => s.id === draft.season) && <option value={draft.season}>利用できないシーズン</option>}
            {seasons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          対局日時（日本時間）
          <Input type="datetime-local" value={draft.date} onChange={(e) => edit({ date: e.target.value })} />
        </label>
      </fieldset>
      <fieldset disabled={locked} className="space-y-3 rounded-lg border p-4">
        <legend className="px-1 font-medium">参加者と素点</legend>
        <p className="text-sm text-muted-foreground">100点単位で入力してください。負点も入力できます。</p>
        {draft.players.map((player, index) => (
          <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,7rem)] gap-2">
            <label className="grid gap-1 text-sm">
              参加者 {index + 1}
              <select className={selectStyle} value={player.id} onChange={(e) => editPlayer(index, { id: e.target.value })}>
                <option value="">参加者を選択</option>
                {player.id && !participants.some((p) => p.id === player.id) && <option value={player.id}>利用できない参加者</option>}
                {participants.map((p) => <option key={p.id} value={p.id}>{participantLabel(p, participants)}</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              素点 {index + 1}
              <Input inputMode="decimal" value={player.score} onChange={(e) => editPlayer(index, { score: e.target.value })} />
            </label>
          </div>
        ))}
        <p className="text-sm tabular-nums">入力合計 {total.toLocaleString("ja-JP")}点{expectedTotal !== null && ` / 開始時総点 ${expectedTotal.toLocaleString("ja-JP")}点`}</p>
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">ゲストを追加</summary>
          <p className="mt-2 text-muted-foreground">再参加のゲストは、参加者欄にある既存の候補を選んでください。複数のリーグで継続して参加する場合は、本人のアカウントで各リーグに参加できます。</p>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <label className="grid flex-1 gap-1">
              ゲスト名
              <Input value={guestName} onChange={(e) => {
                setGuestName(e.target.value)
                setGuestNotice("")
              }} disabled={guest.busy || guest.retry} />
            </label>
            <Button type="button" variant="outline" onClick={() => void createGuest()} disabled={guest.busy || (!guest.retry && !guestName.trim())}>
              {guest.retry ? "ゲスト追加を再試行" : "候補に追加"}
            </Button>
          </div>
          {guest.message && <p role="alert" className="mt-2">{guest.message}</p>}
          {guestNotice && <p role="status" className="mt-2">{guestNotice}</p>}
        </details>
      </fieldset>

      {message && <p role="alert" className="text-sm">{message}</p>}
      {!draft.pending && <Button onClick={() => void calculate()} disabled={busy || guest.busy || rules.length === 0}>計算する</Button>}
      {rules.length === 0 && !draft.pending && <p role="status">利用可能なルールがありません。</p>}
      {preview && (
        <section className="space-y-3" aria-label="計算結果">
          <h2 className="text-lg font-semibold">計算結果</h2>
          <ResultList results={preview.results} detailed />
          {!draft.pending && <Button onClick={() => void save()} disabled={busy || guest.busy}>保存する</Button>}
        </section>
      )}
      {draft.pending && (
        <div className="space-y-2">
          <p role="status">{busy ? "対局を保存しています…" : "入力を保持しています。保存結果を確認するため、同じ操作を再送してください。"}</p>
          <Button onClick={() => void save()} disabled={busy}>同じ内容で再送</Button>
        </div>
      )}
    </div>
  )
}
