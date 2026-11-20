import type { OwnerTransfer } from "@/components/leagues/league-management-forms"
import { LeaguePageError, loadLeaguePage } from "@/components/leagues/league-page-error"
import { LeagueSettings, type Member, type Settings } from "@/components/leagues/league-settings"
import { AppLink, navLink } from "@/components/navigation/app-link"
import { referencePages } from "@/lib/auth/reference-pages"
import { serverAPI } from "@/lib/auth/server"
import { leagueHistory, leagueHome } from "@/lib/leagues/paths"
import type { League, MatchRule, Participant, ParticipantLink, Season } from "@/types/match"

export default async function SettingsPage({ params }: { params: Promise<{ league_id: string }> }) {
  const { league_id } = await params
  const home = leagueHome(league_id)
  const path = `${home}/settings`
  const api = `/api${home}`
  const history = leagueHistory(league_id)
  const result = await loadLeaguePage(async () => {
    const { settings } = await serverAPI<{ settings: Settings }>(`${api}/settings`, path)
    const data = await Promise.all([
      serverAPI<{ league: League }>(api, path),
      referencePages<Member>(api, "members", path),
      referencePages<MatchRule>(api, "rules", path, { available: "all" }),
      referencePages<Season>(api, "seasons", path),
      referencePages<Participant>(api, "participants", path),
      referencePages<ParticipantLink>(api, "participant-links", path),
      serverAPI<{ owner_transfer: OwnerTransfer | null }>(`${api}/owner-transfers/current`, path),
    ])
    return { settings, data }
  })
  let content
  if (result.error) {
    content = <LeaguePageError error={result.error} path={path} back={home} />
  } else {
    const { settings, data: [{ league }, members, rules, seasons, participants, links, transfer] } = result.data
    const linked = new Set(links.filter((l) => l.status === "active").map((l) => l.guest_user_id))
    content = <>
      <nav aria-label="リーグ設定の関連ページ" className="flex flex-wrap gap-2">
        <AppLink className={navLink} href={home}>リーグホーム</AppLink>
        <AppLink className={navLink} href={`${history}/invites`}>招待を管理</AppLink>
        <AppLink className={navLink} href={`${history}/participant-links`}>ゲストの本人紐付け</AppLink>
        <AppLink className={navLink} href={`${path}/events`}>操作記録</AppLink>
      </nav>
      <LeagueSettings league={league} settings={settings} members={members} rules={rules} seasons={seasons}
        guests={participants.filter((p) => p.kind === "guest" && !linked.has(p.id))} transfer={transfer.owner_transfer} />
    </>
  }
  return <main className="mx-auto w-full max-w-2xl space-y-5 px-4 py-6">
    <h1 className="text-2xl font-bold">リーグ設定</h1>
    {content}
  </main>
}
