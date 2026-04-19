import Link from "next/link"

import { MatchCard } from "@/components/match-card"
import { buttonVariants } from "@/components/ui/button"
import type { GetMatchesResponse } from "@/types/match"

export const dynamic = "force-dynamic"

async function getMatches() {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL

  if (!baseUrl) {
    throw new Error("NEXT_PUBLIC_API_URL が設定されていません")
  }

  const response = await fetch(`${baseUrl}/api/matches`, {
    cache: "no-store",
  })

  if (!response.ok) {
    throw new Error("対局履歴の取得に失敗しました")
  }

  const data = (await response.json()) as GetMatchesResponse
  return data.matches
}

export default async function MatchesPage() {
  const matches = await getMatches()

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-4 py-6">
      <header className="mb-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold tracking-tight">対局履歴</h1>
          <Link href="/matches/new" className={buttonVariants({ size: "sm" })}>
            結果を入力
          </Link>
        </div>
        <p className="text-sm text-muted-foreground">最新の対局結果を時系列で確認できます。</p>
      </header>

      {matches.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          対局履歴はまだありません。
        </p>
      ) : (
        <section className="space-y-4">
          {matches.map((match) => (
            <MatchCard key={match.id} match={match} />
          ))}
        </section>
      )}
    </main>
  )
}
