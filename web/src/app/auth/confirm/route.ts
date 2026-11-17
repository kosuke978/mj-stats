import { NextResponse, type NextRequest } from 'next/server'
import { serverSupabase } from '@/lib/supabase/server'
import { safeReturnTo } from '@/lib/auth/paths'
import { appOrigin } from '@/lib/auth/origin'
import {
  recoveryCookie,
  recoveryOptions,
  recoveryProof,
} from '@/lib/auth/recovery'

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const hash = params.get('token_hash')
  const type = params.get('type')
  const next = safeReturnTo(params.get('returnTo'))
  const response = (path: string) => {
    const res = NextResponse.redirect(new URL(path, appOrigin()), 303)
    res.headers.set('Cache-Control', 'private, no-store')
    res.headers.set('Referrer-Policy', 'no-referrer')
    return res
  }
  if (
    !hash ||
    !/^(?:pkce_)?[a-f0-9]{32,256}$/i.test(hash) ||
    (type !== 'email' && type !== 'recovery')
  )
    return response('/auth/error')
  const supabase = await serverSupabase(true)
  try {
    const { data, error } = await supabase.auth.verifyOtp({
      token_hash: hash,
      type,
    })
    if (error || !data.session || !data.user) return response('/auth/error')
    if (type === 'recovery') {
      const res = response('/password/update')
      res.cookies.set(
        recoveryCookie,
        recoveryProof(data.user.id, data.session.access_token),
        recoveryOptions,
      )
      return res
    }
    return response(`/profile/setup?returnTo=${encodeURIComponent(next)}`)
  } catch {
    return response('/auth/error')
  }
}
