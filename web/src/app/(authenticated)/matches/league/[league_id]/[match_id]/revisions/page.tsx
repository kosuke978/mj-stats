import { AuditHeader, AuditNavigation } from "@/components/leagues/audit-display"
import { LeaguePageError, loadLeaguePage } from "@/components/leagues/league-page-error"
import { ResultList } from "@/components/matches/result-list"
import { serverAPI } from "@/lib/auth/server"
import { leagueHistory, leagueHome } from "@/lib/leagues/paths"
import type { MatchHistory } from "@/types/match"

type Revision = {
  id: string; operation: "create" | "update" | "cancel"; version: string; actor_id: string
  created_at: string; reason: string | null; before: MatchHistory | null; after: MatchHistory
}

const operations = { create: "作成", update: "訂正", cancel: "取消" }

function Snapshot({ match }: { match: MatchHistory }) {
  const date = match.match_date && new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium", timeStyle: "medium", timeZone: "Asia/Tokyo",
  }).format(new Date(match.match_date))
  return <div className="grid gap-2 py-2">
    <dl className="text-sm wrap-anywhere">
      <div><dt className="font-medium">対局日時（日本時間）</dt><dd>{date || "未指定"}</dd></div>
      <div><dt className="font-medium">ルールID</dt><dd>{match.rule_id}</dd></div>
      <div><dt className="font-medium">シーズンID</dt><dd>{match.season_id ?? "未指定"}</dd></div>
      <div><dt className="font-medium">状態</dt><dd>{match.status === "valid" ? "有効" : "取消済み"}</dd></div>
    </dl>
    <ResultList results={match.results} detailed />
  </div>
}

export default async function RevisionsPage({ params, searchParams }: {
  params: Promise<{ league_id: string; match_id: string }>
  searchParams: Promise<{ cursor?: string | string[] }>
}) {
  const { league_id, match_id } = await params
  const { cursor } = await searchParams
  const id = encodeURIComponent(match_id)
  const back = `${leagueHistory(league_id)}/${id}`
  const path = `${back}/revisions`
  const page = await loadLeaguePage(async () => {
    const query = new URLSearchParams({ limit: "10" })
    for (const value of cursor ? [cursor].flat() : []) query.append("cursor", value)
    return serverAPI<{ revisions: Revision[]; next_cursor: string | null }>(
      `/api${leagueHome(league_id)}/matches/${id}/revisions?${query}`, path)
  })
  let content
  if (page.error) {
    content = <LeaguePageError error={page.error} path={path} back={back} />
  } else {
    const result = page.data
    content = <>
      <AuditNavigation path={path} back={back} cursor={typeof cursor === "string" ? cursor : undefined} next={result.next_cursor} />
      {result.revisions.length === 0 && <p>変更記録はありません。</p>}
      {result.revisions.map((item) => <article key={item.id} className="space-y-2 rounded-lg border p-3">
        <AuditHeader label={`${operations[item.operation]}（版 ${item.version}）`} actor={item.actor_id} date={item.created_at} reason={item.reason} />
        {item.before && <details><summary className="min-h-11 cursor-pointer py-2">変更前</summary><Snapshot match={item.before} /></details>}
        <details><summary className="min-h-11 cursor-pointer py-2">変更後</summary><Snapshot match={item.after} /></details>
      </article>)}
    </>
  }
  return <main className="mx-auto w-full max-w-2xl space-y-5 px-4 py-6">
    <h1 className="text-2xl font-bold">対局の変更履歴</h1>
    {content}
  </main>
}
