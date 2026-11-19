// Only implemented application routes may be a login return destination.
export function safeReturnTo(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\\p{Cc}\u2028\u2029]/u.test(value)
  )
    return '/'
  try {
    const decoded = decodeURIComponent(value)
    if (decoded !== value) return '/'
    const url = new URL(value, 'https://app.invalid')
    if (url.pathname !== value) return '/'
    if (url.origin !== 'https://app.invalid' || url.hash || url.search)
      return '/'
    const leagueHome = /^\/leagues\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
    const leagueHistory = /^\/matches\/league\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?:\/(?:invites|new|participant-links|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}))?$/i
    const joinPage = /^\/join\/[0-9]{12}$/
    const pages = ['/', '/matches', '/matches/new', '/account', '/leagues/new', '/leagues/search']
    return (pages.includes(url.pathname) || leagueHome.test(url.pathname) || leagueHistory.test(url.pathname) || joinPage.test(url.pathname))
      ? url.pathname
      : '/'
  } catch {
    return '/'
  }
}
export function loginPath(returnTo: string) {
  return `/login?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`
}
