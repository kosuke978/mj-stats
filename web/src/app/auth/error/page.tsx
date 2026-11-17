import Link from 'next/link'
export default function AuthError() {
  return (
    <main className="mx-auto max-w-lg space-y-5 px-4 py-8">
      <h1 className="text-2xl font-bold">確認できませんでした</h1>
      <p role="alert">
        リンクが無効・期限切れ・使用済みの可能性があります。新しいメールを依頼してください。
      </p>
      <div className="flex flex-wrap gap-4 underline">
        <Link href="/login">ログイン・確認メールの再送</Link>
        <Link href="/password/reset">パスワード再設定を依頼</Link>
      </div>
    </main>
  )
}
