import { MembershipActions, type OwnerTransfer } from "@/components/leagues/league-management-forms"
import { AppLink, navLink } from '@/components/navigation/app-link'
import { LeagueNavigation } from '@/components/navigation/navigation'
import { APIError } from '@/lib/auth/api'
import { requireViewer, serverAPI } from '@/lib/auth/server'
import { leagueHistory, leagueHome, leagueRoles } from '@/lib/leagues/paths'
import type { League } from '@/types/match'

export default async function LeagueHomePage({ params }: { params: Promise<{ league_id: string }> }) {
  const { league_id } = await params
  const path = leagueHome(league_id)
  let league: League
  let transfer: OwnerTransfer | null = null
  let transferUnavailable = false
  try {
    const result = await serverAPI<{ league: League }>(`/api${path}`, path)
    league = result.league
  } catch (error) {
    if (!(error instanceof APIError || error instanceof TypeError)) throw error
    const denied = error instanceof APIError && error.code === 'LEAGUE_ACCESS_DENIED'
    return (
      <main className="mx-auto w-full max-w-2xl space-y-4 px-4 py-6">
        <h1 className="text-2xl font-bold">リーグホーム</h1>
        <p role="alert">{denied ? 'このリーグは閲覧できません。' : 'リーグを取得できませんでした。'}</p>
        {!denied && <AppLink className={navLink} href={path}>再試行</AppLink>}
        <AppLink className={navLink} href="/">所属リーグ一覧へ</AppLink>
        {denied && <AppLink className={navLink} href="/leagues/search">名前・番号から参加</AppLink>}
      </main>
    )
  }

  const history = leagueHistory(league.id)
  const { viewer } = await requireViewer(path)
  try {
    const result = await serverAPI<{ owner_transfer: OwnerTransfer | null }>(`/api${path}/owner-transfers/current`, path)
    transfer = result.owner_transfer
  } catch (error) {
    if (!(error instanceof APIError || error instanceof TypeError)) throw error
    transferUnavailable = true
  }
  return (
    <main className="mx-auto w-full max-w-2xl space-y-5 px-4 py-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold wrap-anywhere">{league.name}</h1>
        <p className="flex flex-wrap gap-x-3 text-sm text-muted-foreground">
          <span>{leagueRoles[league.my_role]}</span>
          <span>グループ番号 <span className="font-mono">{league.group_number}</span></span>
        </p>
      </header>
      <LeagueNavigation id={league.id} active="home" />
      <ul className="border-t pt-3 text-sm">
        {league.my_role !== 'member' && <li><AppLink className={navLink} href={`${path}/settings`}>リーグ設定</AppLink></li>}
        {league.my_role !== 'member' && <li><AppLink className={navLink} href={`${history}/invites`}>招待を管理</AppLink></li>}
        <li><AppLink className={navLink} href={`${history}/participant-links`}>ゲストの本人紐付け</AppLink></li>
      </ul>
      {transferUnavailable && <p role="alert" className="text-sm">引継ぎの状態を取得できませんでした。再読込してください。</p>}
      <MembershipActions endpoint={`/api${path}`} viewerID={viewer.id} owner={league.my_role === "owner"} transfer={transfer} />
    </main>
  )
}
