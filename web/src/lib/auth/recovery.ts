import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'

export const recoveryCookie = 'mjstats-recovery'
function secret() {
  const value = process.env.AUTH_FLOW_SECRET
  if (!value || value.length < 32)
    throw new Error('AUTH_FLOW_SECRET を設定してください')
  return value
}
function sessionID(token: string) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
      .session_id as string
  } catch {
    return null
  }
}
export function recoveryProof(subject: string, token: string) {
  const data = Buffer.from(
    JSON.stringify({
      subject,
      session: sessionID(token),
      expires: Date.now() + 10 * 60_000,
    }),
  ).toString('base64url')
  return `${data}.${createHmac('sha256', secret()).update(data).digest('base64url')}`
}
export function validRecovery(
  proof: string | undefined,
  subject: string,
  token: string,
) {
  if (!proof) return false
  const [data, signature, extra] = proof.split('.')
  if (!data || !signature || extra) return false
  const expected = createHmac('sha256', secret()).update(data).digest()
  const actual = Buffer.from(signature, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return false
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString())
    return (
      payload.subject === subject &&
      payload.session &&
      payload.session === sessionID(token) &&
      payload.expires > Date.now()
    )
  } catch {
    return false
  }
}
export const recoveryOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 600,
}
