import Link from "next/link"
import { serverAPI } from "@/lib/auth/server"
import type { League } from "@/types/match"

export const dynamic = "force-dynamic"

const roles = { owner: "オーナー", admin: "管理者", member: "メンバー" }

export default async function MatchesPage() {
  const { leagues } = await serverAPI<{ leagues: League[] }>("/api/leagues", "/matches")

  return (
    <main className="mx-auto w-full max-w-2xl space-y-4 px-4 py-6">
      <h1 className="text-2xl font-bold tracking-tight">対局履歴</h1>
      {leagues.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm">所属しているリーグがありません。</p>
      ) : (
        <nav aria-label="リーグを選択">
          <ul className="space-y-2">
            {leagues.map((league) => (
              <li key={league.id}>
                <Link
                  href={`/matches/league/${league.id}`}
                  prefetch={false}
                  className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border p-3 hover:bg-muted"
                >
                  <span className="min-w-0 font-medium wrap-anywhere">{league.name}</span>
                  <span className="text-sm text-muted-foreground">{roles[league.my_role]}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </main>
  )
}
