import { AuditHeader, AuditNavigation } from "@/components/leagues/audit-display"
import { LeaguePageError, loadLeaguePage } from "@/components/leagues/league-page-error"
import { serverAPI } from "@/lib/auth/server"
import { leagueHome } from "@/lib/leagues/paths"

type LeagueEvent = {
  id: string; operation: string; actor_id: string; target: string; version: string
  created_at: string; reason: string | null; before: object | null; after: object
}

const operations: Record<string, string> = {
  "league.create": "リーグ作成", "league.join": "リーグ参加", "league.settings": "リーグ設定",
  "invite.issue": "招待発行", "invite.revoke": "招待失効", "rule.create": "ルール新版作成", "rule.available": "ルール利用可否変更",
  "season.create": "シーズン作成", "season.update": "シーズン更新",
  "member.role": "権限変更", "member.remove": "除名", "member.leave": "脱退",
  "owner-transfer.propose": "引継ぎ指名", "owner-transfer.accept": "引継ぎ同意", "owner-transfer.cancel": "引継ぎ指名取消",
  "guest.create": "ゲスト追加", "guest.rename": "ゲスト名変更",
  "participant-link.request": "本人紐付け申請", "participant-link.approve": "本人紐付け承認",
  "participant-link.reject": "本人紐付け却下", "participant-link.revoke": "本人紐付け解除",
}

export default async function LeagueEventsPage({ params, searchParams }: {
  params: Promise<{ league_id: string }>
  searchParams: Promise<{ cursor?: string | string[] }>
}) {
  const { league_id } = await params
  const { cursor } = await searchParams
  const home = leagueHome(league_id)
  const back = `${home}/settings`
  const path = `${back}/events`
  const page = await loadLeaguePage(async () => {
    const query = new URLSearchParams()
    for (const value of cursor ? [cursor].flat() : []) query.append("cursor", value)
    return serverAPI<{ events: LeagueEvent[]; next_cursor: string | null }>(`/api${home}/events?${query}`, path)
  })
  let content
  if (page.error) {
    content = <LeaguePageError error={page.error} path={path} back={back} />
  } else {
    const result = page.data
    content = <>
      <AuditNavigation path={path} back={back} cursor={typeof cursor === "string" ? cursor : undefined} next={result.next_cursor} />
      {result.events.length === 0 && <p>操作記録はありません。</p>}
      {result.events.map((item) => <article key={item.id} className="space-y-2 rounded-lg border p-3">
        <AuditHeader label={operations[item.operation] ?? item.operation} actor={item.actor_id} date={item.created_at} reason={item.reason} />
        <p className="text-sm wrap-anywhere">対象ID {item.target} · 版 {item.version}</p>
        {item.before && <details><summary className="min-h-11 cursor-pointer py-2">変更前</summary>
          <pre className="whitespace-pre-wrap wrap-anywhere text-xs">{JSON.stringify(item.before, null, 2)}</pre></details>}
        {Object.keys(item.after).length > 0 && <details><summary className="min-h-11 cursor-pointer py-2">変更後</summary>
          <pre className="whitespace-pre-wrap wrap-anywhere text-xs">{JSON.stringify(item.after, null, 2)}</pre></details>}
      </article>)}
    </>
  }
  return <main className="mx-auto w-full max-w-2xl space-y-5 px-4 py-6">
    <h1 className="text-2xl font-bold">リーグの操作記録</h1>
    {content}
  </main>
}
