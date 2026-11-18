import Link from 'next/link'
import { InviteManagement } from '@/components/leagues/invite-management'
import { APIError } from '@/lib/auth/api'
import { serverAPI } from '@/lib/auth/server'
import type { League } from '@/types/match'

export default async function InvitesPage({ params }: { params: Promise<{ league_id: string }> }) {
  const { league_id: id } = await params
  const history = `/matches/league/${encodeURIComponent(id)}`
  let league: League | undefined
  let error = ''
  try {
    league = (await serverAPI<{ league: League }>(`/api/leagues/${encodeURIComponent(id)}`, history + '/invites')).league
  } catch (e) {
    if (e instanceof APIError) {
      error = e.status === 403 ? 'このリーグの招待は管理できません。' : 'リーグを取得できませんでした。'
    } else if (e instanceof TypeError) {
      error = 'リーグを取得できませんでした。'
    } else {
      throw e
    }
  }
  const canManage = league?.my_role === 'owner' || league?.my_role === 'admin'
  return (
    <main className="mx-auto w-full max-w-lg space-y-4 px-4 py-6">
      <nav className="flex flex-wrap gap-4 text-sm underline">
        <Link href="/matches" prefetch={false}>所属リーグ一覧へ</Link>
        {league && <Link href={history} prefetch={false}>対局履歴へ</Link>}
      </nav>
      <h1 className="text-2xl font-bold">リーグの招待</h1>
      {canManage && league ? (
        <>
          <p className="wrap-anywhere">{league.name}</p>
          <InviteManagement key={league.id} leagueID={league.id} />
        </>
      ) : <p role="alert">{error || 'このリーグの招待は管理できません。'}</p>}
    </main>
  )
}
