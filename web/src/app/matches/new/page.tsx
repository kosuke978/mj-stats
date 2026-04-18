import { MatchInputForm } from "@/components/match/MatchInputForm"

export default function NewMatchPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col px-4 py-6">
      <header className="mb-5 space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">対局結果を入力</h1>
        <p className="text-sm text-muted-foreground">4人のプレイヤーと持ち点を入力して成績を登録します。</p>
      </header>

      <MatchInputForm />
    </main>
  )
}
