import Link from 'next/link'
import { CreateLeague } from '@/components/leagues/create-league'

export default function NewLeaguePage() {
  return (
    <main className="mx-auto w-full max-w-lg space-y-4 px-4 py-6">
      <Link href="/matches" className="text-sm underline">所属リーグ一覧へ</Link>
      <h1 className="text-2xl font-bold">リーグを作成</h1>
      <CreateLeague />
    </main>
  )
}
