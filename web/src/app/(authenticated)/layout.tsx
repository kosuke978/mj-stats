import { headers } from 'next/headers'
import { requireViewer } from '@/lib/auth/server'
import { ViewerProvider } from '@/components/auth/viewer-provider'

export const dynamic = 'force-dynamic'
export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const path = (await headers()).get('x-mjstats-path') ?? '/matches'
  const current = await requireViewer(path, path === '/profile/setup')
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
