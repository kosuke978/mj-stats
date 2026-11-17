import { NextResponse, type NextRequest } from 'next/server'
import { serverSupabase } from '@/lib/supabase/server'
import { safeReturnTo, loginPath } from '@/lib/auth/paths'
import { appOrigin } from '@/lib/auth/origin'
import { tokenFetch } from '@/lib/auth/api'
export async function GET(request: NextRequest) {
  const next = safeReturnTo(request.nextUrl.searchParams.get('returnTo'))
  const supabase = await serverSupabase(true)
  try {
    const { data, error } = await supabase.auth.refreshSession()
    if (error && (error.status === 0 || (error.status ?? 0) >= 500))
      return new NextResponse(
        '認証の更新に失敗しました。再読込してください。',
        { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
      )
    const valid =
      !error &&
      data.session &&
      (await tokenFetch('/api/users/me', data.session.access_token)).status
    if (valid && valid >= 500)
      return new NextResponse(
        '本人情報を確認できません。再読込してください。',
        { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
      )
    if (valid !== 200) {
      // Do not leave a locally restored but server-revoked session in a redirect loop.
      await supabase.auth.signOut({ scope: 'local' })
    }
    const res = NextResponse.redirect(
      new URL(valid === 200 ? next : loginPath(next), appOrigin()),
      303,
    )
    res.headers.set('Cache-Control', 'private, no-store')
    return res
  } catch {
    return new NextResponse('認証の更新に失敗しました。再読込してください。', {
      status: 503,
      headers: { 'Cache-Control': 'private, no-store' },
    })
  }
}
