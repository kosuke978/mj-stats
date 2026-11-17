import { redirect } from 'next/navigation'
import { ProfileForm } from '@/components/auth/profile-form'
import { requireViewer } from '@/lib/auth/server'
import { safeReturnTo } from '@/lib/auth/paths'
export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>
}) {
  const returnTo = safeReturnTo((await searchParams).returnTo)
  const { viewer } = await requireViewer(returnTo, true)
  if (viewer.profile_completed_at) redirect(returnTo)
  return (
    <main className="mx-auto w-full max-w-lg space-y-5 px-4 py-8">
      <h1 className="text-2xl font-bold">はじめに表示名を設定</h1>
      <p>対局や成績に表示する名前を入力してください。</p>
      <ProfileForm setup returnTo={returnTo} />
    </main>
  )
}
