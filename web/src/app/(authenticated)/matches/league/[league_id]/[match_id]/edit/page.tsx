import { LeaguePageError, loadLeaguePage } from "@/components/leagues/league-page-error"
import { MatchManagement } from "@/components/matches/match-management"
import { AppLink, navLink } from "@/components/navigation/app-link"
import { referencePages } from "@/lib/auth/reference-pages"
import { serverAPI } from "@/lib/auth/server"
import { leagueHistory, leagueHome } from "@/lib/leagues/paths"
import type { MatchHistory, MatchRule, Participant, Season } from "@/types/match"

export default async function EditMatchPage({ params }: { params: Promise<{ league_id: string; match_id: string }> }) {
  const { league_id, match_id } = await params
  const id = encodeURIComponent(match_id)
  const endpoint = `/api${leagueHome(league_id)}`
  const detail = `${leagueHistory(league_id)}/${id}`
  const path = `${detail}/edit`
  const result = await loadLeaguePage(async () => {
    await serverAPI(`${endpoint}/matches/${id}/revisions?limit=1`, path)
    const match = await serverAPI<MatchHistory>(`${endpoint}/matches/${id}`, path)
    if (match.status === "cancelled") return { match, references: null }
    const references = await Promise.all([
      referencePages<MatchRule>(endpoint, "rules", path, { available: "all" }),
      referencePages<Season>(endpoint, "seasons", path),
      referencePages<Participant>(endpoint, "participants", path),
    ])
    return { match, references }
  })
  let content
  if (result.error) {
    content = <LeaguePageError error={result.error} path={path} back={detail} />
  } else if (!result.data.references) {
    content = <p role="status">この対局は取消済みです。</p>
  } else {
    const { match, references: [rules, seasons, participants] } = result.data
    content = <MatchManagement key={match.version} match={match} rules={rules} seasons={seasons} participants={participants} detail={detail} />
  }
  return <main className="mx-auto w-full max-w-2xl space-y-5 px-4 py-6">
    <h1 className="text-2xl font-bold">対局の訂正・取消</h1>
    <AppLink className={navLink} href={detail}>対局詳細へ</AppLink>
    {content}
  </main>
}
