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
    if (url.origin !== 'https://app.invalid' || url.hash || url.search)
      return '/matches'
    return ['/matches', '/matches/new', '/account'].includes(url.pathname)
      ? url.pathname
      : '/matches'
  } catch {
    return '/matches'
  }
}
export function loginPath(returnTo: string) {
  return `/login?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`
}
