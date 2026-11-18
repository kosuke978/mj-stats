import Link from 'next/link'
import { FindLeague } from '@/components/leagues/find-league'

export default function FindLeaguePage() {
  return (
    <main className="mx-auto w-full max-w-lg space-y-4 px-4 py-6">
      <Link href="/matches" className="text-sm underline">所属リーグ一覧へ</Link>
      <h1 className="text-2xl font-bold">リーグに参加</h1>
      <p className="text-sm text-muted-foreground">招待リンクをお持ちの方は、そのリンクから参加できます。</p>
      <FindLeague />
    </main>
  )
}
