import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { serverSupabase } from '@/lib/supabase/server'
import { recoveryCookie, validRecovery } from '@/lib/auth/recovery'
import { PasswordForm } from '@/components/auth/password-form'
export default async function UpdatePassword() {
  const supabase = await serverSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (
    !user ||
    !session ||
    !validRecovery(
      (await cookies()).get(recoveryCookie)?.value,
      user.id,
      session.access_token,
    )
  )
    redirect('/auth/error')
  return (
    <main className="mx-auto w-full max-w-md space-y-6 px-4 py-8">
      <h1 className="text-2xl font-bold">パスワードを更新</h1>
      <PasswordForm />
    </main>
  )
}
