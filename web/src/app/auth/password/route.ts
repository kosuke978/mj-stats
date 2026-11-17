import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'
import { serverSupabase } from '@/lib/supabase/server'
import { appOrigin } from '@/lib/auth/origin'
import {
  recoveryCookie,
  recoveryOptions,
  validRecovery,
} from '@/lib/auth/recovery'
import { tokenFetch } from '@/lib/auth/api'

export async function POST(request: NextRequest) {
  const fail = (status: number, message: string) =>
    NextResponse.json(
      { message },
      { status, headers: { 'Cache-Control': 'private, no-store' } },
    )
  if (request.headers.get('origin') !== appOrigin())
    return fail(403, '再設定メールからやり直してください。')
  if (
    !(request.headers.get('content-type') ?? '').startsWith('application/json')
  )
    return fail(415, '入力内容を確認してください。')
  const body = await request.text()
  if (body.length > 4096) return fail(413, '入力内容を確認してください。')
  let password: unknown
  try {
    const data = JSON.parse(body)
    if (Object.keys(data).length !== 1)
      return fail(400, '入力内容を確認してください。')
    password = data.password
  } catch {
    return fail(400, '入力内容を確認してください。')
  }
  if (
    typeof password !== 'string' ||
    password.length < 8 ||
    password.length > 1024
  )
    return fail(400, '8文字以上のパスワードを入力してください。')
  const supabase = await serverSupabase(true)
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()
  if (error && (error.status === 0 || (error.status ?? 0) >= 500))
    return fail(503, '認証を確認できません。再試行してください。')
  const {
    data: { session },
  } = await supabase.auth.getSession()
  const store = await cookies()
  if (
    !user ||
    !session ||
    !validRecovery(
      store.get(recoveryCookie)?.value,
      user.id,
      session.access_token,
    )
  )
    return fail(401, '再設定リンクが無効です。新しいメールを依頼してください。')
  const verified = await tokenFetch('/api/users/me', session.access_token)
  if (!verified.ok)
    return fail(
      verified.status === 401 ? 401 : 503,
      '本人のセッションを確認できません。再試行してください。',
    )
  const updated = await supabase.auth.updateUser({ password })
  if (updated.error)
    return fail(
      updated.error.status === 0 || (updated.error.status ?? 0) >= 500
        ? 503
        : 400,
      '更新できませんでした。時間をおいて再試行してください。',
    )
  store.set(recoveryCookie, '', { ...recoveryOptions, maxAge: 0 })
  return NextResponse.json(
    { message: 'パスワードを更新しました。' },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
