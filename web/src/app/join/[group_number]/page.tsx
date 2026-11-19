import { AppLink } from '@/components/navigation/app-link'
import { notFound } from 'next/navigation'
import { ViewerProvider } from '@/components/auth/viewer-provider'
import { InviteHandoff, JoinLeague } from '@/components/leagues/join-league'
import { APIError } from '@/lib/auth/api'
import { loginPath } from '@/lib/auth/paths'
import { getViewer } from '@/lib/auth/server'

export const dynamic = 'force-dynamic'

export default async function JoinPage({ params }: { params: Promise<{ group_number: string }> }) {
  const { group_number: number } = await params
  if (!/^[0-9]{12}$/.test(number)) notFound()
  const path = `/join/${number}`
  let current: Awaited<ReturnType<typeof getViewer>> = null
  let unavailable = false
  try {
    current = await getViewer()
  } catch (error) {
    unavailable = !(error instanceof APIError && error.status === 401)
  }

  const heading = (
    <>
      <h1 className="text-2xl font-bold">リーグへの参加</h1>
      <p className="text-sm">グループ番号 <span className="font-mono">{number}</span></p>
    </>
  )
  if (current?.viewer.profile_completed_at) {
    return (
      <ViewerProvider key={current.viewer.id} initial={current.viewer} subject={current.subject}>
        <main className="mx-auto w-full max-w-lg space-y-4 px-4 py-6">
          <AppLink href="/leagues/search" className="text-sm underline">リーグを探す</AppLink>
          {heading}
          <p className="text-sm text-muted-foreground">コードが表示されない場合は、招待リンクを開き直すか、受け取ったコードを入力してください。</p>
          <JoinLeague key={number} groupNumber={number} />
        </main>
      </ViewerProvider>
    )
  }
  const query = `returnTo=${encodeURIComponent(path)}`
  return (
    <main className="mx-auto w-full max-w-lg space-y-4 px-4 py-6">
      {heading}
      {unavailable ? (
        <p role="alert">本人情報を確認できませんでした。時間をおいてページを開き直してください。</p>
      ) : (
        <section className="space-y-3 rounded-lg border p-4">
          <p className="text-sm">
            同じタブで手続きすると参加画面に戻ります。コードが表示されない場合は、招待リンクを開き直すか、受け取ったコードを入力してください。
          </p>
          <InviteHandoff groupNumber={number} subject={current?.subject ?? null}>
            <div className="flex flex-wrap gap-4 underline">
              {current ? (
                <AppLink href={`/profile/setup?${query}`}>表示名を設定</AppLink>
              ) : (
                <>
                  <AppLink href={loginPath(path)}>ログイン</AppLink>
                  <AppLink href={`/signup?${query}`}>新規登録</AppLink>
                </>
              )}
            </div>
          </InviteHandoff>
        </section>
      )}
    </main>
  )
}
