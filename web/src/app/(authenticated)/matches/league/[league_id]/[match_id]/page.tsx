import Link from "next/link"
import { MatchCard } from "@/components/match-card"
import { APIError } from "@/lib/auth/api"
import { serverAPI } from "@/lib/auth/server"
import type { MatchHistory, MatchRule, Season } from "@/types/match"
import { referencePages } from "@/lib/auth/reference-pages"

export default async function MatchDetailPage({ params }: { params: Promise<{ league_id: string; match_id: string }> }) {
  const { league_id, match_id } = await params
  const id = encodeURIComponent(league_id)
  const history = `/matches/league/${id}`
  const path = `${history}/${encodeURIComponent(match_id)}`
  const endpoint = `/api/leagues/${id}`
  let content
  try {
    const match = await serverAPI<MatchHistory>(`${endpoint}/matches/${encodeURIComponent(match_id)}`, path)
    const [rules, seasons] = await Promise.all([
      referencePages<MatchRule>(endpoint, "rules", path, { available: "all" }),
      match.season_id ? referencePages<Season>(endpoint, "seasons", path) : Promise.resolve([]),
    ])
    const rule = rules.find((item) => item.id === match.rule_id)
    const season = seasons.find((item) => item.id === match.season_id)
    content = (
      <>
        <dl className="space-y-2 text-sm">
          <div><dt className="font-medium">適用ルール</dt><dd className="break-all">{rule?.name ?? match.rule_id}</dd></div>
          {rule && <div><dt className="font-medium">計算条件</dt><dd>{rule.default_points.toLocaleString("ja-JP")}点持ち、{rule.return_points.toLocaleString("ja-JP")}点返し、ウマ {rule.uma.join(" / ")}</dd></div>}
          <div><dt className="font-medium">シーズン</dt><dd>{season?.name ?? match.season_id ?? "未指定"}</dd></div>
        </dl>
        <MatchCard match={match} />
      </>
    )
  } catch (error) {
    if (!(error instanceof APIError || error instanceof TypeError)) throw error
    content = <p role="alert">{error instanceof APIError ? error.message : "対局を取得できませんでした。"}</p>
  }
  return (
    <main className="mx-auto w-full max-w-2xl space-y-5 px-4 py-6">
      <Link href={history} className="text-sm underline" prefetch={false}>対局履歴へ</Link>
      <h1 className="text-2xl font-bold">対局詳細</h1>
      {content}
    </main>
  )
}
