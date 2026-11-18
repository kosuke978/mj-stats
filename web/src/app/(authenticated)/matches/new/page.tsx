import Link from "next/link"

export default function NewMatchPage() {
  return (
    <main className="mx-auto w-full max-w-xl space-y-4 px-4 py-6">
      <h1 className="text-2xl font-bold tracking-tight">対局記録</h1>
      <p>対局の計算・記録は現在利用できません。</p>
      <Link href="/matches" prefetch={false} className="underline">履歴を見る</Link>
    </main>
  )
}
