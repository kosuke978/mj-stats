'use client'
import { browserSupabase } from '@/lib/supabase/browser'
import { APIError, apiResponse, tokenFetch } from './api'
import { loginPath } from './paths'

export async function clientAPI<T>(
  path: string,
  init: RequestInit = {},
  expectedSubject?: string,
): Promise<T> {
  const supabase = browserSupabase()
  let {
    data: { session },
    error,
  } = await supabase.auth.getSession()
  if (error || !session) {
    if (
      error &&
      (!('status' in error) || error.status === 0 || (error.status ?? 0) >= 500)
    )
      throw new Error('認証を確認できません。再試行してください')
    window.location.replace(loginPath(window.location.pathname))
    throw new APIError(401, 'UNAUTHENTICATED', 'ログインし直してください')
  }
  const originalSubject = session.user.id
  if (expectedSubject && originalSubject !== expectedSubject) {
    window.location.replace(loginPath(window.location.pathname))
    throw new APIError(401, 'UNAUTHENTICATED', '本人が変わりました。画面を開き直してください')
  }
  let response = await tokenFetch(path, session.access_token, init)
  if (response.status === 401) {
    // Go's 401 is guaranteed to precede side effects. Never retry network/5xx writes.
    const refreshed = await supabase.auth.refreshSession()
    session = refreshed.data.session
    error = refreshed.error
    if (
      error &&
      (!('status' in error) || error.status === 0 || (error.status ?? 0) >= 500)
    )
      throw new Error('認証を更新できません。再試行してください')
    if (session && session.user.id !== originalSubject) {
      window.location.replace(loginPath(window.location.pathname))
      throw new APIError(
        401,
        'UNAUTHENTICATED',
        '本人が変わりました。画面を開き直してください',
      )
    }
    if (session && !error)
      response = await tokenFetch(path, session.access_token, init)
    if (!session || error || response.status === 401) {
      window.location.replace(loginPath(window.location.pathname))
      throw new APIError(401, 'UNAUTHENTICATED', 'ログインし直してください')
    }
  }
  if (response.status === 403) {
    const data = await response
      .clone()
      .json()
      .catch(() => null)
    if (
      data?.error?.code === 'PROFILE_INCOMPLETE' ||
      data?.error?.code === 'PROFILE_REQUIRED'
    ) {
      window.location.replace(
        `/profile/setup?returnTo=${encodeURIComponent(window.location.pathname)}`,
      )
    }
  }
  return apiResponse<T>(response)
}
