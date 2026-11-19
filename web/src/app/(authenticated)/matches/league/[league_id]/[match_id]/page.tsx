import { AppLink } from "@/components/navigation/app-link"
import { MatchCard } from "@/components/match-card"
import { LeagueNavigation } from "@/components/navigation/navigation"
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
        <LeagueNavigation id={match.league_id} />
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
    const denied = error instanceof APIError && error.code === "LEAGUE_ACCESS_DENIED"
    const missing = error instanceof APIError && [400, 404].includes(error.status)
    content = (
      <>
        <p role="alert">{denied ? "このリーグは閲覧できません。" : missing ? "対局を確認できませんでした。" : "対局を取得できませんでした。"}</p>
        <div className="flex flex-wrap gap-4 underline">
          {denied && <AppLink href="/leagues/search">リーグに参加</AppLink>}
          {denied ? <AppLink href="/">所属リーグ一覧へ</AppLink> : <AppLink href={history}>対局履歴へ</AppLink>}
          {!denied && !missing && <AppLink href={path}>再試行</AppLink>}
        </div>
      </>
    )
  }
  return (
    <main className="mx-auto w-full max-w-2xl space-y-5 px-4 py-6">
      <h1 className="text-2xl font-bold">対局詳細</h1>
      {content}
    </main>
  )
}
