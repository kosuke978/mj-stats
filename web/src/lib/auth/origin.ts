import 'server-only'
export function appOrigin() {
  const origin = process.env.APP_ORIGIN
  if (!origin || new URL(origin).origin !== origin)
    throw new Error('APP_ORIGIN を設定してください')
  const parsed = new URL(origin)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local))
    throw new Error('APP_ORIGIN はHTTPSまたは専用ローカルURLにしてください')
  return origin
}
