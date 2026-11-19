// Only implemented application routes may be a login return destination.
export function safeReturnTo(value: string | null | undefined): string {
  if (
    !value ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\\p{Cc}\u2028\u2029]/u.test(value)
  )
    return '/matches'
  try {
    const decoded = decodeURIComponent(value)
    if (decoded !== value || /%[0-9a-f]{2}/i.test(decoded)) return '/matches'
    const url = new URL(value, 'https://app.invalid')
    if (url.pathname !== value) return '/matches'
    if (url.origin !== 'https://app.invalid' || url.hash || url.search)
      return '/matches'
    const leagueHistory = /^\/matches\/league\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?:\/(?:invites|new|participant-links|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}))?$/i
    const joinPage = /^\/join\/[0-9]{12}$/
    const pages = ['/matches', '/matches/new', '/account', '/leagues/new', '/leagues/search']
    return (pages.includes(url.pathname) || leagueHistory.test(url.pathname) || joinPage.test(url.pathname))
      ? url.pathname
      : '/matches'
  } catch {
    return '/matches'
  }
}
export function loginPath(returnTo: string) {
  return `/login?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`
}
