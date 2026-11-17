import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { loginPath, safeReturnTo } from '@/lib/auth/paths'

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname
  const headers = new Headers(request.headers)
  headers.set('x-mjstats-path', path)
  let response = NextResponse.next({ request: { headers } })
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(values, authHeaders) {
          values.forEach(({ name, value }) => request.cookies.set(name, value))
          headers.set('cookie', request.cookies.toString())
          response = NextResponse.next({ request: { headers } })
          values.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          )
          Object.entries(authHeaders).forEach(([name, value]) =>
            response.headers.set(name, value),
          )
        },
      },
    },
  )
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()
  const protectedPage =
    path === '/account' ||
    path.startsWith('/matches') ||
    path === '/profile/setup' ||
    path === '/password/update'
  if (
    protectedPage &&
    error &&
    (error.status === 0 || (error.status ?? 0) >= 500)
  ) {
    // An Auth outage must not erase a recoverable session or masquerade as logout.
    return new NextResponse(
      '認証を確認できません。時間をおいて再読込してください。',
      {
        status: 503,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'private, no-store',
        },
      },
    )
  }
  if (protectedPage && !user) {
    const redirected = NextResponse.redirect(
      new URL(loginPath(safeReturnTo(path)), process.env.APP_ORIGIN!),
    )
    response.cookies
      .getAll()
      .forEach((cookie) => redirected.cookies.set(cookie))
    redirected.headers.set('Cache-Control', 'private, no-store')
    return redirected
  }
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}
export const config = {
  matcher: [
    '/((?!auth/confirm|auth/password|auth/refresh|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
