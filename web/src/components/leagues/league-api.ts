'use client'

import { useRef, useState } from 'react'
import { APIError } from '@/lib/auth/api'
import { clientAPI } from '@/lib/auth/client-api'
import { useViewer } from '@/components/auth/viewer-provider'

export type LeagueSummary = { id: string; name: string; group_number: string }
export type Post = { path: string; body: Record<string, string> }

export function leagueMessage(error: unknown) {
  if (error instanceof APIError) {
    if (error.status === 429)
      return error.retryAfter
        ? `${error.retryAfter}秒ほど待ってから再試行してください。`
        : '少し待ってから再試行してください。'
    return error.message
  }
  return '接続できませんでした。通信状態を確認して再試行してください。'
}

export function useLeagueAction() {
  const { subject } = useViewer()
  const pending = useRef<Post | null>(null)
  const started = useRef(false)
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(false)
  const [message, setMessage] = useState('')

  async function run<T>(next: Post | null, onRejected?: (code: string) => void): Promise<T | undefined> {
    if (started.current) return
    const post = pending.current ?? next
    if (!post) return
    started.current = true
    setBusy(true)
    setMessage('')
    try {
      const result = await clientAPI<T>(post.path, {
        method: 'POST',
        body: JSON.stringify(post.body),
      }, subject)
      pending.current = null
      setRetry(false)
      return result
    } catch (error) {
      const unclear = !(error instanceof APIError) || error.status >= 500
      const limited = error instanceof APIError && error.status === 429
      if (error instanceof APIError && !unclear && !limited) onRejected?.(error.code)
      pending.current = unclear || limited ? post : null
      setRetry(pending.current !== null)
      setMessage(unclear
        ? '送信結果を確認できませんでした。同じ操作を再試行してください。'
        : leagueMessage(error))
    } finally {
      started.current = false
      setBusy(false)
    }
  }

  return { run, busy, retry, message }
}
