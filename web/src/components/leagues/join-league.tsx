'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useViewer } from '@/components/auth/viewer-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { APIError } from '@/lib/auth/api'
import { clientAPI } from '@/lib/auth/client-api'
import { leagueMessage, type LeagueSummary, useLeagueAction } from './league-api'

// The browser is the sole reader of the fragment. Remove it before navigation.
export function useInviteFragment(receive?: (code: string) => void) {
  useEffect(() => {
    function read() {
      const hash = window.location.hash
      if (!hash) return
      const code = new URLSearchParams(hash.slice(1)).get('code')
      window.history.replaceState(window.history.state, '', window.location.pathname)
      if (code && code.length <= 64 && receive) queueMicrotask(() => receive(code))
    }
    read()
    window.addEventListener('hashchange', read)
    return () => window.removeEventListener('hashchange', read)
  }, [receive])
}

export function DiscardInviteFragment() {
  useInviteFragment()
  return null
}

type Preview = { league: LeagueSummary; expires_at: string }
type Membership = { league_id: string; status: 'active' | 'left' | 'removed' }

export function JoinLeague({ groupNumber }: { groupNumber: string }) {
  const { subject } = useViewer()
  const [code, setCode] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const checking = useRef(false)
  const [message, setMessage] = useState('')
  const action = useLeagueAction()
  const receive = useCallback((value: string) => {
    if (checking.current || action.busy || action.retry) return
    setCode(value)
    setPreview(null)
    setMessage('')
  }, [action.busy, action.retry])
  useInviteFragment(receive)

  async function confirmCode(event: React.FormEvent) {
    event.preventDefault()
    if (!code || checking.current || action.busy || action.retry) return
    checking.current = true
    setBusy(true)
    setMessage('')
    setPreview(null)
    try {
      const result = await clientAPI<Preview>('/api/leagues/join-preview', {
        method: 'POST',
        body: JSON.stringify({ group_number: groupNumber, code }),
      }, subject)
      setPreview(result)
    } catch (error) {
      if (error instanceof APIError && error.code === 'INVALID_INVITE') setCode('')
      setMessage(leagueMessage(error))
    } finally {
      checking.current = false
      setBusy(false)
    }
  }

  async function join() {
    if (!preview) return
    const leagueID = preview.league.id
    const result = await action.run<{ membership: Membership }>(action.retry ? null : {
      path: `/api/leagues/${leagueID}/join`,
      body: { code, client_request_id: crypto.randomUUID() },
    }, (reason) => {
      if (reason === 'INVALID_INVITE') {
        setCode('')
        setPreview(null)
      }
    })
    if (!result) return
    setCode('')
    setPreview(null)
    if (result.membership.status === 'active') {
      window.location.assign(`/matches/league/${leagueID}`)
    } else {
      setMessage('現在の所属は終了しています。参加する場合は有効な招待を確認してください。')
    }
  }

  return (
    <section className="space-y-4 rounded-lg border p-4">
      <form onSubmit={confirmCode} className="grid gap-2">
        <Label htmlFor="join-code">参加コード</Label>
        <Input id="join-code" value={code} type="text" autoComplete="off" spellCheck={false}
          disabled={busy || action.busy || action.retry} onChange={(e) => {
            setCode(e.target.value)
            setPreview(null)
            setMessage('')
          }} required />
        <Button type="submit" size="lg" variant="outline" disabled={busy || action.busy || action.retry}>
          招待を確認
        </Button>
      </form>
      {preview && (
        <div className="space-y-3 rounded-md bg-muted p-3">
          <p className="font-medium wrap-anywhere">{preview.league.name}</p>
          <p className="text-sm">参加すると、このリーグの履歴を閲覧できます。</p>
          <Button type="button" size="lg" disabled={action.busy} onClick={() => void join()}>
            {action.retry ? '参加を再試行' : 'このリーグに参加'}
          </Button>
        </div>
      )}
      {message && <p role="alert" className="text-sm">{message}</p>}
      {action.message && <p role="alert" className="text-sm">{action.message}</p>}
    </section>
  )
}
