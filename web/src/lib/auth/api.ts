export type Viewer = {
  id: string
  name: string
  profile_completed_at: string | null
}
export class APIError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}
export async function apiResponse<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>
  const data = await response.json().catch(() => null)
  throw new APIError(
    response.status,
    data?.error?.code ?? 'INTERNAL_ERROR',
    data?.error?.message ?? '処理に失敗しました。再試行してください',
  )
}
export async function tokenFetch(
  path: string,
  token: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body) headers.set('Content-Type', 'application/json')
  return fetch(`${process.env.NEXT_PUBLIC_API_URL}${path}`, {
    ...init,
    headers,
    cache: 'no-store',
  })
}
