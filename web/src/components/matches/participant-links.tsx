"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { useLeagueAction, type Post } from "@/components/leagues/league-api"
import { Button } from "@/components/ui/button"
import type { League, Participant, ParticipantLink } from "@/types/match"
import { participantLabel } from "./participant-label"

export function ParticipantLinks({ league, participants, initial }: { league: League; participants: Participant[]; initial: ParticipantLink[] }) {
  const router = useRouter()
  const action = useLeagueAction()
  const [guest, setGuest] = useState("")
  const [consent, setConsent] = useState(false)
  const [selected, setSelected] = useState("")
  const [note, setNote] = useState("")
  const [notice, setNotice] = useState("")
  const endpoint = `/api/leagues/${league.id}/participant-links`
  const guests = participants.filter((p) => p.kind === "guest" &&
    !initial.some((item) => item.guest_user_id === p.id && item.status === "active"))
  const disabled = action.busy || action.retry

  async function submit(kind?: "request" | "approve" | "reject" | "revoke", link?: ParticipantLink) {
    const id = crypto.randomUUID()
    const post: Post | null = kind === "request"
      ? { path: endpoint, body: { guest_user_id: guest, client_request_id: id } }
      : link && kind
        ? { path: `${endpoint}/${link.id}/${kind}`, body: { ...(kind === "revoke" ? { reason: note } : { confirmation_note: note }), version: link.version, client_request_id: id } }
        : null
    setNotice("")
    const result = await action.run<{ participant_link?: ParticipantLink }>(post)
    if (!result) return
    setGuest("")
    setConsent(false)
    setSelected("")
    setNote("")
    const state = result.participant_link?.status
    setNotice(state === "pending" ? "本人申請を記録しました。" : state === "active" ? "本人紐付けを承認しました。" : state === "rejected" ? "申請を却下しました。" : "本人紐付けを解除しました。")
    router.refresh()
  }

  return (
    <div className="space-y-5">
      <p className="font-medium wrap-anywhere">{league.name}</p>
      <fieldset disabled={disabled} className="space-y-3 rounded-lg border p-4">
        <legend className="px-1 font-medium">自分への紐付けを申請</legend>
        <label className="grid gap-1 text-sm">
          ゲスト
          <select value={guest} onChange={(e) => setGuest(e.target.value)} className="w-full rounded-md border bg-background px-2 py-2">
            <option value="">ゲストを選択</option>
            {guests.map((p) => <option key={p.id} value={p.id}>{participantLabel(p, participants)}</option>)}
          </select>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1" />
          選択したゲストが私本人であり、このリーグで過去成績を紐付けることに同意します。
        </label>
        <Button onClick={() => void submit("request")} disabled={!guest || !consent}>本人として申請</Button>
      </fieldset>
      {action.message && <p role="alert" className="text-sm">{action.message}</p>}
      {action.retry && <Button onClick={() => void submit()} disabled={action.busy}>同じ操作を再試行</Button>}
      {notice && <p role="status">{notice}</p>}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">本人紐付けの申請一覧</h2>
        {initial.length === 0 && <p className="text-sm">申請はありません。</p>}
        {initial.map((link) => (
          <div key={link.id} className="space-y-2 rounded-lg border p-4 text-sm">
            <p className="wrap-anywhere">{link.guest_name}（{link.guest_user_id.slice(0, 8)}） → {link.registered_name}（{link.registered_user_id.slice(0, 8)}）</p>
            <p>{link.status === "active" ? "承認済み" : link.status === "rejected" ? "却下済み" : link.status === "revoked" ? "解除済み" : "確認待ち"}</p>
            {link.confirmation_note && <p className="whitespace-pre-wrap wrap-anywhere">{link.confirmation_note}</p>}
            {league.my_role !== "member" && link.status === "pending" && (
              selected === link.id ? (
                <fieldset disabled={disabled} className="space-y-2">
                  <label className="grid gap-1">
                    確認内容
                    <textarea className="min-h-20 w-full rounded-md border bg-background p-2" value={note} onChange={(e) => setNote(e.target.value)} />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => void submit("approve", link)} disabled={!note.trim()}>承認</Button>
                    <Button variant="outline" onClick={() => void submit("reject", link)} disabled={!note.trim()}>却下</Button>
                  </div>
                </fieldset>
              ) : (
                <Button variant="outline" disabled={disabled} onClick={() => {
                  setSelected(link.id)
                  setNote("")
                }}>申請を確認</Button>
              )
            )}
            {league.my_role === "owner" && link.status === "active" && (
              selected === link.id
                ? <fieldset disabled={disabled} className="space-y-2">
                    <label className="grid gap-1">解除理由
                      <textarea maxLength={500} className="min-h-20 w-full rounded-md border bg-background p-2" value={note} onChange={(e) => setNote(e.target.value)} />
                    </label>
                    <p>元のゲストに成績を戻します。対局結果は保持されます。</p>
                    <Button variant="destructive" className="min-h-11" onClick={() => void submit("revoke", link)} disabled={!note.trim()}>本人紐付けを解除する</Button>
                  </fieldset>
                : <Button variant="outline" className="min-h-11" disabled={disabled} onClick={() => { setSelected(link.id); setNote("") }}>紐付け解除</Button>
            )}
          </div>
        ))}
      </section>
    </div>
  )
}
