import 'server-only'
import { cache } from 'react'
import { redirect } from 'next/navigation'
import { serverSupabase } from '@/lib/supabase/server'
import { APIError, apiResponse, tokenFetch, type Viewer } from './api'
import { loginPath, safeReturnTo } from './paths'

// React cache is scoped to the current render, never a shared user cache.
export const getViewer = cache(async () => {
  const supabase = await serverSupabase()
  const { data, error } = await supabase.auth.getUser()
  if (error && (error.status === 0 || (error.status ?? 0) >= 500))
    throw new Error('認証を確認できません。再試行してください')
  if (!data.user) return null
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return null
  const viewer = await apiResponse<Viewer>(
    await tokenFetch('/api/users/me', session.access_token),
  )
  return { viewer, token: session.access_token, subject: data.user.id }
})

export async function requireViewer(returnTo: string, allowIncomplete = false) {
  let current
  try {
    current = await getViewer()
  } catch (error) {
    if (error instanceof APIError && error.status === 401)
      redirect(
        `/auth/refresh?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`,
      )
    throw error
  }
  if (!current) redirect(loginPath(returnTo))
  if (!allowIncomplete && !current.viewer.profile_completed_at)
    redirect(
      `/profile/setup?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`,
    )
  return current
}

export async function serverAPI<T>(path: string, returnTo: string): Promise<T> {
  const current = await requireViewer(returnTo)
  const response = await tokenFetch(path, current.token)
  if (response.status === 401)
    redirect(
      `/auth/refresh?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`,
    )
  return apiResponse<T>(response)
}
