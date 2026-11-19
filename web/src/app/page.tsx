import { Suspense } from 'react'
import { AuthenticatedShell } from '@/components/auth/authenticated-shell'
import { LeagueDirectory, LeagueDirectoryLoading } from '@/components/navigation/league-directory'

export const dynamic = 'force-dynamic'

export default function HomePage() {
  return (
    <AuthenticatedShell>
      <main className="mx-auto w-full max-w-2xl space-y-5 px-4 py-6">
        <h1 className="text-2xl font-bold">所属リーグ</h1>
        <Suspense fallback={<LeagueDirectoryLoading />}>
          <LeagueDirectory path="/" />
        </Suspense>
      </main>
    </AuthenticatedShell>
  )
}
