import Link from "next/link"
import { MatchCard } from "@/components/match-card"
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
        {path && <Link href={path} prefetch={false} className="underline">履歴を読み直す</Link>}
        <Link href="/matches" prefetch={false} className="underline">所属リーグ一覧へ</Link>
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
        <Link href="/matches" prefetch={false} className="text-sm underline">リーグを切り替える</Link>
        <h1 className="text-2xl font-bold wrap-anywhere">{league.name}の対局履歴</h1>
        <p className="text-sm text-muted-foreground">対局の計算・記録は現在利用できません。</p>
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
          {seasonCursor && <Link href={pageLink(path, { season })} prefetch={false}>最初の候補</Link>}
          {seasonPage.next_cursor && <Link href={pageLink(path, { season, season_cursor: seasonPage.next_cursor })} prefetch={false}>さらに候補を表示</Link>}
        </nav>
      )}
      {history.matches.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm">対象の対局はありません。</p>
      ) : (
        <section className="space-y-4" aria-label="対局一覧">
          {history.matches.map((match) => <MatchCard key={match.id} match={match} />)}
        </section>
      )}
      {history.next_cursor && (
        <Link href={pageLink(path, { season, cursor: history.next_cursor })} prefetch={false} className="underline">
          次の対局を表示
        </Link>
      )}
    </main>
  )
}
