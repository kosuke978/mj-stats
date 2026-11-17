'use client'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
export default function AuthenticatedError({ reset }: { reset: () => void }) {
  return (
    <main className="mx-auto max-w-lg space-y-4 p-6">
      <h1 className="text-xl font-bold">取得できませんでした</h1>
      <p role="alert">通信状態を確認し、再試行してください。</p>
      <Button onClick={reset}>再試行</Button>
      <p>
        <Link className="underline" href="/login">
          ログイン画面へ
        </Link>
      </p>
    </main>
  )
}
