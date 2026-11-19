import Link from "next/link"

export default function NewMatchPage() {
  return (
    <main className="mx-auto w-full max-w-xl space-y-4 px-4 py-6">
      <h1 className="text-2xl font-bold tracking-tight">対局記録</h1>
      <p>所属リーグの履歴から対局を入力できます。</p>
      <Link href="/matches" prefetch={false} className="underline">所属リーグを選ぶ</Link>
    </main>
  )
}
