import { AppLink } from "@/components/navigation/app-link"
import { MatchEntry } from "@/components/matches/match-entry"
import { LeagueNavigation } from "@/components/navigation/navigation"
import { APIError } from "@/lib/auth/api"
import { referencePages } from "@/lib/auth/reference-pages"
import { serverAPI } from "@/lib/auth/server"
import type { League, MatchRule, Participant, Season } from "@/types/match"

export default async function MatchEntryPage({ params }: { params: Promise<{ league_id: string }> }) {
  const { league_id } = await params
  const id = encodeURIComponent(league_id)
  const history = `/matches/league/${id}`
  const path = `${history}/new`
  const api = `/api/leagues/${id}`
  let data
  try {
    data = await Promise.all([
      serverAPI<{ league: League }>(api, path),
      referencePages<Participant>(api, "participants", path),
      referencePages<MatchRule>(api, "rules", path),
      referencePages<Season>(api, "seasons", path),
    ])
  } catch (error) {
    if (!(error instanceof APIError || error instanceof TypeError)) throw error
    const denied = error instanceof APIError && error.code === "LEAGUE_ACCESS_DENIED"
    return (
      <main className="mx-auto max-w-2xl space-y-4 px-4 py-6">
        <h1 className="text-2xl font-bold">対局入力</h1>
        <p role="alert">{denied ? "このリーグは閲覧できません。" : "入力候補を取得できませんでした。"}</p>
        <div className="flex flex-wrap gap-4 underline">
          {denied ? <AppLink href="/leagues/search">リーグに参加</AppLink> : <AppLink href={path}>再試行</AppLink>}
          <AppLink href="/">所属リーグ一覧へ</AppLink>
        </div>
      </main>
    )
  }
  const [{ league }, participants, rules, seasons] = data
  return (
    <main className="mx-auto w-full max-w-2xl space-y-5 px-[min(1rem,4vw)] py-6">
        <h1 className="text-2xl font-bold wrap-anywhere">{league.name}の対局入力</h1>
      <LeagueNavigation id={league.id} active="entry" />
        <MatchEntry leagueID={league.id} participants={participants} rules={rules} seasons={seasons} />
      </main>
    )
}
