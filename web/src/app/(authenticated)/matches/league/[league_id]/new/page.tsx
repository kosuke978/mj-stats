import Link from "next/link"
import { MatchEntry } from "@/components/matches/match-entry"
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
    return (
      <main className="mx-auto max-w-2xl space-y-4 px-4 py-6">
        <h1 className="text-2xl font-bold">対局入力</h1>
        <p role="alert">{error instanceof APIError ? error.message : "入力候補を取得できませんでした。"}</p>
        <Link href={history} className="underline" prefetch={false}>対局履歴へ</Link>
      </main>
    )
  }
  const [{ league }, participants, rules, seasons] = data
  return (
      <main className="mx-auto w-full max-w-2xl space-y-5 px-4 py-6">
        <Link href={history} className="text-sm underline" prefetch={false}>対局履歴へ</Link>
        <h1 className="text-2xl font-bold wrap-anywhere">{league.name}の対局入力</h1>
        <MatchEntry leagueID={league.id} participants={participants} rules={rules} seasons={seasons} />
      </main>
    )
}
