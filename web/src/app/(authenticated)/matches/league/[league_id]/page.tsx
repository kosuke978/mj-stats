import { AppLink } from "@/components/navigation/app-link"
import { MatchCard } from "@/components/match-card"
import { LeagueNavigation } from "@/components/navigation/navigation"
import { buttonVariants } from "@/components/ui/button"
import { APIError } from "@/lib/auth/api"
import { serverAPI } from "@/lib/auth/server"
import type { GetMatchesResponse, League, Season } from "@/types/match"

export const dynamic = "force-dynamic"

function pageLink(path: string, params: Record<string, string>) {
  const query = new URLSearchParams(params).toString()
  return query ? `${path}?${query}` : path
}

function HistoryError({ message, path }: { message: string; path?: string }) {
  return (
    <main className="mx-auto w-full max-w-2xl space-y-4 px-4 py-6">
      <h1 className="text-2xl font-bold">対局履歴</h1>
      <p role="alert">{message}</p>
      <div className="flex flex-wrap gap-4">
        {path && <AppLink href={path} className="underline">履歴を読み直す</AppLink>}
        <AppLink href="/" className="underline">所属リーグ一覧へ</AppLink>
        {!path && <AppLink href="/leagues/search" className="underline">リーグに参加</AppLink>}
      </div>
    </main>
  )
}

export default async function LeagueHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ league_id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { league_id: id } = await params
  const path = `/matches/league/${encodeURIComponent(id)}`
  const endpoint = `/api/leagues/${encodeURIComponent(id)}`
  const query = await searchParams
  const { season = "all", cursor, season_cursor: seasonCursor } = query
  if (typeof season !== "string" || Array.isArray(cursor) || Array.isArray(seasonCursor)) {
    return <HistoryError message="表示条件を確認してください。" path={path} />
  }

  let league: League
  let seasonPage: { seasons: Season[]; next_cursor: string | null }
  let history: GetMatchesResponse
  try {
    const [detail, seasons, matches] = await Promise.all([
      serverAPI<{ league: League }>(endpoint, path),
      serverAPI<typeof seasonPage>(
        pageLink(`${endpoint}/seasons`, seasonCursor ? { cursor: seasonCursor } : {}),
        path,
      ),
      serverAPI<GetMatchesResponse>(
        pageLink(`${endpoint}/matches`, cursor ? { season, cursor } : { season }),
        path,
      ),
    ])
    league = detail.league
    seasonPage = seasons
    history = matches
  } catch (error) {
    if (error instanceof APIError) {
      if (error.code === "LEAGUE_ACCESS_DENIED") {
        return <HistoryError message="このリーグは閲覧できません。" />
      }
      if (error.status === 400 || error.status === 404) {
        return <HistoryError message="表示条件を確認してください。" path={path} />
      }
      if (error.status === 503) {
        return <HistoryError message="対局履歴を取得できませんでした。" path={path} />
      }
    }
    if (error instanceof TypeError) {
      return <HistoryError message="対局履歴を取得できませんでした。" path={path} />
    }
    throw error
  }

  const seasonNameInPage = seasonPage.seasons.some((item) => item.id === season)
  return (
    <main className="mx-auto w-full max-w-2xl space-y-5 px-4 py-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold wrap-anywhere">{league.name}の対局履歴</h1>
        <LeagueNavigation id={league.id} active="history" />
        <div className="flex flex-wrap gap-4 text-sm underline">
          <AppLink href={path + "/participant-links"}>ゲストの本人紐付け</AppLink>
          {league.my_role !== "member" && <AppLink href={path + "/invites"}>招待を管理</AppLink>}
        </div>
      </header>
      <form action={path} method="get" className="flex flex-wrap items-end gap-2">
        <label className="grid min-w-0 gap-1 text-sm">
          シーズン
          <select name="season" defaultValue={season} className="max-w-full rounded-md border bg-background px-2 py-1.5">
            <option value="all">通算</option>
            <option value="unassigned">未指定のみ</option>
            {season !== "all" && season !== "unassigned" && !seasonNameInPage &&
              <option value={season}>選択中のシーズン</option>}
            {seasonPage.seasons.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <button className={buttonVariants({ variant: "outline", size: "sm" })}>表示する</button>
      </form>
      {(seasonCursor || seasonPage.next_cursor) && (
        <nav aria-label="シーズン候補のページ" className="flex flex-wrap gap-4 text-sm underline">
          {seasonCursor && <AppLink href={pageLink(path, { season })}>最初の候補</AppLink>}
          {seasonPage.next_cursor && <AppLink href={pageLink(path, { season, season_cursor: seasonPage.next_cursor })}>さらに候補を表示</AppLink>}
        </nav>
      )}
      {history.matches.length === 0 ? (
        <section className="space-y-3 rounded-lg border border-dashed p-4 text-sm">
          <p>対象の対局はありません。</p>
          <AppLink href={path + "/new"} className="inline-block underline">対局を記録する</AppLink>
        </section>
      ) : (
        <section className="space-y-4" aria-label="対局一覧">
          {history.matches.map((match) => <MatchCard key={match.id} match={match} detailURL={`${path}/${match.id}`} />)}
        </section>
      )}
      {history.next_cursor && (
        <AppLink href={pageLink(path, { season, cursor: history.next_cursor })} className="underline">
          次の対局を表示
        </AppLink>
      )}
    </main>
  )
}
