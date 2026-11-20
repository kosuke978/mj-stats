import { LeaguePageError, loadLeaguePage } from "@/components/leagues/league-page-error"
import { displayPoint } from "@/components/matches/result-list"
import { LeagueNavigation } from "@/components/navigation/navigation"
import { Button } from "@/components/ui/button"
import { referencePages } from "@/lib/auth/reference-pages"
import { serverAPI } from "@/lib/auth/server"
import { leagueHome } from "@/lib/leagues/paths"
import type { ExactPoint, Season } from "@/types/match"

type Ranking = {
  season: string
  entries: {
    rank: number; user_id: string; display_name: string; kind: "guest" | "registered"
    total_point: ExactPoint; match_count: number; membership_status: "active" | "left" | "removed"
  }[]
}

export default async function RankingPage({ params, searchParams }: {
  params: Promise<{ league_id: string }>
  searchParams: Promise<{ season?: string | string[] }>
}) {
  const { league_id } = await params
  const { season = "all" } = await searchParams
  const home = leagueHome(league_id)
  const path = `${home}/ranking`
  const endpoint = `/api${home}`
  const result = await loadLeaguePage(async () => {
    const query = new URLSearchParams()
    for (const value of [season].flat()) query.append("season", value)
    return Promise.all([
      serverAPI<Ranking>(`${endpoint}/ranking?${query}`, path),
      referencePages<Season>(endpoint, "seasons", path),
    ])
  })
  let content
  if (result.error) {
    content = <LeaguePageError error={result.error} path={path} back={home} />
  } else {
    const [ranking, seasons] = result.data
    const names = new Map<string, number>()
    for (const row of ranking.entries) names.set(row.display_name, (names.get(row.display_name) ?? 0) + 1)
    content = (
      <>
        <LeagueNavigation id={league_id} active="ranking" />
        <form action={path} className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 max-w-full">
            <span className="block font-medium">対象シーズン</span>
            <select name="season" defaultValue={ranking.season} className="min-h-11 w-full rounded-md border bg-background px-2">
              <option value="all">通算（未指定を含む）</option>
              <option value="unassigned">未指定のみ</option>
              {seasons.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <Button type="submit" className="min-h-11">表示</Button>
        </form>
        <p className="text-sm text-muted-foreground">有効な対局の合計ptで順位を付けます。同じ合計ptは同順位です。</p>
        {ranking.entries.length === 0 ? <p role="status">この範囲に成績はありません。</p> : (
          <ol className="grid gap-2">
            {ranking.entries.map((row) => (
              <li key={row.user_id} className="rounded-lg border p-3">
                <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                  <span className="min-w-0 font-semibold wrap-anywhere">
                    {row.rank}位 {row.display_name}{(names.get(row.display_name) ?? 0) > 1 && ` (${row.user_id.slice(0, 8)})`}
                    {row.kind === "guest" && "（ゲスト）"}
                    {row.membership_status === "left" && "（脱退済み）"}
                    {row.membership_status === "removed" && "（除名済み）"}
                  </span>
                  <span className="min-w-0 tabular-nums wrap-anywhere">{displayPoint(row.total_point)} pt · {row.match_count}対局</span>
                </div>
                <details className="mt-1 text-sm">
                  <summary className="cursor-pointer py-1">正確な合計pt</summary>
                  <p className="wrap-anywhere">{row.total_point.numerator}/{row.total_point.denominator} pt</p>
                </details>
              </li>
            ))}
          </ol>
        )}
      </>
    )
  }
  return <main className="mx-auto w-full max-w-2xl space-y-5 px-4 py-6">
    <h1 className="text-2xl font-bold">順位表</h1>
    {content}
  </main>
}
