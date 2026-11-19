"use client"

import { useRouter } from "next/navigation"
import { useState, type FormEvent, type ReactNode } from "react"
import { useLeagueAction } from "@/components/leagues/league-api"
import { Button } from "@/components/ui/button"

export const managementField = "min-h-11 w-full min-w-0 rounded-md border bg-background px-2 py-1.5"

export function ManagementForm({ path, method, label, payload, children, destructive = false, leave = false }: {
  path: string; method?: "PATCH"; label: string
  payload: (data: FormData) => Record<string, unknown>; children?: ReactNode
  destructive?: boolean; leave?: boolean
}) {
  const router = useRouter()
  const action = useLeagueAction()
  const [saved, setSaved] = useState(false)
  const [conflict, setConflict] = useState(false)

  async function send(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    const body = event ? { ...payload(new FormData(event.currentTarget)), client_request_id: crypto.randomUUID() } : null
    setSaved(false)
    const result = await action.run(body ? { path, method, body } : null, (code) => {
      if (["VERSION_CONFLICT", "STATE_CONFLICT", "FORBIDDEN", "LEAGUE_ACCESS_DENIED"].includes(code)) setConflict(true)
    })
    if (result) {
      setSaved(true)
      if (leave) router.replace("/")
      router.refresh()
    }
  }

  return (
    <form onSubmit={(event) => void send(event)} className="space-y-2">
      <fieldset disabled={action.busy || action.retry || conflict || saved} className="grid min-w-0 gap-2">
        {children}
        <Button type="submit" className="min-h-11 max-w-full justify-self-start whitespace-normal" variant={destructive ? "destructive" : "default"}>
          {action.busy ? "送信中…" : label}
        </Button>
      </fieldset>
      {saved && <p role="status" className="text-sm">変更を保存しました。</p>}
      {action.message && <p role="alert" className="text-sm">{action.message}</p>}
      {action.retry && <Button className="min-h-11" onClick={() => void send()} disabled={action.busy}>同じ操作を再試行</Button>}
      {(conflict || saved) && <Button className="min-h-11" variant="outline" onClick={() => window.location.reload()}>最新の状態を表示</Button>}
    </form>
  )
}

export type OwnerTransfer = {
  id: string; from_user_id: string; to_user_id: string; status: "pending" | "expired"
  expires_at: string; version: string
}

export function MembershipActions({ endpoint, viewerID, owner, transfer }: {
  endpoint: string; viewerID: string; owner: boolean; transfer: OwnerTransfer | null
}) {
  const pending = transfer?.status === "pending" && transfer.to_user_id === viewerID ? transfer : null
  if (owner && !pending) return null
  return (
    <section className="space-y-4 border-t pt-4">
      {pending && <div className="space-y-2 rounded-lg border p-3">
        <h2 className="font-semibold">オーナー引継ぎの依頼</h2>
        <p className="text-sm">有効期限 {new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo" }).format(new Date(pending.expires_at))}（日本時間）</p>
        <ManagementForm path={`${endpoint}/owner-transfers/${pending.id}/accept`} label="同意して引き継ぐ" payload={() => ({ version: pending.version })}>
          <label className="flex items-start gap-2"><input type="checkbox" required className="mt-1" />このリーグのオーナーを引き継ぐことに同意します</label>
        </ManagementForm>
      </div>}
      {!owner && <details>
        <summary className="min-h-11 cursor-pointer py-2 font-medium">リーグから脱退</summary>
        <ManagementForm path={`${endpoint}/leave`} label="脱退する" payload={() => ({})} destructive leave>
          <p className="text-sm">脱退後はリーグを閲覧できなくなります。記録済みの成績は残ります。</p>
          <label className="flex items-start gap-2"><input type="checkbox" required className="mt-1" />脱退することを確認しました</label>
        </ManagementForm>
      </details>}
    </section>
  )
}
