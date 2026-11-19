import { AppLink } from '@/components/navigation/app-link'
import { ProfileForm } from '@/components/auth/profile-form'
import { requireViewer } from '@/lib/auth/server'
export default async function AccountPage() {
  await requireViewer('/account')
  return (
    <main className="mx-auto w-full max-w-lg space-y-5 px-4 py-8">
      <h1 className="text-2xl font-bold">アカウント</h1>
      <ProfileForm />
      <AppLink className="inline-block underline" href="/">
        所属リーグ一覧へ
      </AppLink>
    </main>
  )
}
