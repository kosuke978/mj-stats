import { APIError } from '@/lib/auth/api'
import { serverAPI } from '@/lib/auth/server'
import { leagueHistory, leagueHome, leagueRoles } from '@/lib/leagues/paths'
import type { League } from '@/types/match'
import { AppLink, navLink } from './app-link'
import { ResumeLegacyRoute } from './league-selection'
import { LeagueActions } from './navigation'

export function LeagueDirectoryLoading() {
  return <p role="status" className="rounded-lg border p-4">所属リーグを読み込んでいます…</p>
}

export async function LeagueDirectory({ path }: { path: '/' | '/matches' | '/matches/new' }) {
  const legacy = path !== '/'
  let leagues: League[]
  try {
    const result = await serverAPI<{ leagues: League[] }>('/api/leagues', path)
    leagues = result.leagues
  } catch (error) {
    if (!(error instanceof APIError || error instanceof TypeError)) throw error
    return (
      <section className="space-y-2 rounded-lg border p-4">
        <p role="alert">所属リーグを取得できませんでした。</p>
        <AppLink className={navLink} href={path}>再試行</AppLink>
      </section>
    )
  }

  if (leagues.length === 0) {
    return (
      <div className="space-y-4">
        <p className="rounded-lg border border-dashed p-4">所属しているリーグがありません。</p>
        <LeagueActions />
      </div>
    )
  }

  const entry = path === '/matches/new'
  return (
    <div className="space-y-4">
      {legacy && <ResumeLegacyRoute leagues={leagues} entry={entry} />}
      <ul className="grid gap-3 sm:grid-cols-2">
        {leagues.map((league) => (
          <li key={league.id} className="min-w-0">
            <AppLink
              href={legacy ? leagueHistory(league.id) + (entry ? '/new' : '') : leagueHome(league.id)}
              className="grid gap-2 rounded-lg border bg-card p-4 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <span className="text-lg font-semibold wrap-anywhere">{league.name}</span>
              <span className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
                <span>{leagueRoles[league.my_role]}</span>
                <span className="font-mono wrap-anywhere">{league.group_number}</span>
              </span>
            </AppLink>
          </li>
        ))}
      </ul>
      <LeagueActions />
    </div>
  )
}
