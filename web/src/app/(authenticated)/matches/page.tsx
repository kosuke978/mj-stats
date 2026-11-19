import { Suspense } from 'react'
import { LeagueDirectory, LeagueDirectoryLoading } from '@/components/navigation/league-directory'

export default function LegacyPage() {
  return (
    <main className="mx-auto w-full max-w-2xl space-y-5 px-4 py-6">
      <h1 className="text-2xl font-bold">対局履歴のリーグを選択</h1>
      <Suspense fallback={<LeagueDirectoryLoading />}>
        <LeagueDirectory path="/matches" />
      </Suspense>
    </main>
  )
}
