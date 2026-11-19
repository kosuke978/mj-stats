import { headers } from 'next/headers'
import { requireViewer } from '@/lib/auth/server'
import { ViewerProvider } from '@/components/auth/viewer-provider'
import { AppLink, navLink } from '@/components/navigation/app-link'
import { APIError } from '@/lib/auth/api'
import { safeReturnTo } from '@/lib/auth/paths'

export async function AuthenticatedShell({
  children,
}: {
  children: React.ReactNode
}) {
  const path = (await headers()).get('x-mjstats-path') ?? '/'
  let current
  try {
    current = await requireViewer(path, path === '/profile/setup')
  } catch (error) {
    if (!(error instanceof APIError || error instanceof TypeError)) throw error
    return (
      <main className="mx-auto w-full max-w-lg space-y-4 p-6">
        <h1 className="text-xl font-bold">本人情報を取得できませんでした</h1>
        <p role="alert">通信状態を確認し、ページを開き直してください。</p>
        <AppLink className={navLink} href={path === '/profile/setup' ? '' : safeReturnTo(path)}>再試行</AppLink>
      </main>
    )
  }
  return (
    <ViewerProvider
      key={current.viewer.id}
      initial={current.viewer}
      subject={current.subject}
    >
      {children}
    </ViewerProvider>
  )
}
