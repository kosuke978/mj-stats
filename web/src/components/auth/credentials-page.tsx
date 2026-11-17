import { redirect } from 'next/navigation'
import { serverSupabase } from '@/lib/supabase/server'
import { appOrigin } from '@/lib/auth/origin'
import { safeReturnTo } from '@/lib/auth/paths'
import { CredentialsForm } from './credentials-form'
export async function CredentialsPage({
  mode,
  returnTo,
}: {
  mode: 'login' | 'signup' | 'reset'
  returnTo?: string
}) {
  const supabase = await serverSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (user && mode !== 'reset') redirect(safeReturnTo(returnTo))
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-8">
      <h1 className="text-2xl font-bold">
        {mode === 'login'
          ? 'MJ-Stats にログイン'
          : mode === 'signup'
            ? 'MJ-Stats に登録'
            : 'パスワードの再設定'}
      </h1>
      <CredentialsForm
        mode={mode}
        returnTo={safeReturnTo(returnTo)}
        origin={appOrigin()}
      />
    </main>
  )
}
