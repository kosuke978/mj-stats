import Link from 'next/link'
import { ProfileForm } from '@/components/auth/profile-form'
import { requireViewer } from '@/lib/auth/server'
export default async function AccountPage() {
  await requireViewer('/account')
  return (
    <main className="mx-auto w-full max-w-lg space-y-5 px-4 py-8">
      <h1 className="text-2xl font-bold">アカウント</h1>
      <ProfileForm />
      <Link className="inline-block underline" href="/matches">
        対局履歴へ
      </Link>
    </main>
  )
}
