'use client'

import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react'
import { useViewer } from '@/components/auth/viewer-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { APIError } from '@/lib/auth/api'
import { clientAPI } from '@/lib/auth/client-api'
import { captureInvite, clearPendingInvite, inviteDiscarded, restoreInvite } from '@/lib/auth/pending-invite'
import { leagueMessage, type LeagueSummary, useLeagueAction } from './league-api'

// Capture before showing the auth links, and remove the fragment from history.
function useInviteLink(groupNumber: string, subject: string | null, receive: (code: string | null) => void) {
  const deliver = useEffectEvent(receive)
  useEffect(() => {
    let mounted = true
    function load() {
      const hash = window.location.hash
      let code = restoreInvite(groupNumber, subject)
      if (hash) {
        const fromLink = new URLSearchParams(hash.slice(1)).get('code')
        window.history.replaceState(window.history.state, '', window.location.pathname)
        if (fromLink && fromLink.length <= 64) {
          captureInvite(groupNumber, fromLink, subject)
          code = fromLink
        }
      }
      queueMicrotask(() => {
        if (mounted) deliver(code)
      })
    }
    load()
    window.addEventListener('hashchange', load)
    return () => {
      mounted = false
      window.removeEventListener('hashchange', load)
    }
  }, [groupNumber, subject])
}

export function InviteHandoff({ groupNumber, subject, children }: {
  groupNumber: string
  subject: string | null
  children: ReactNode
}) {
  const [ready, setReady] = useState(false)
  useInviteLink(groupNumber, subject, () => setReady(true))
  return ready ? children : <p role="status" className="text-sm">参加画面を準備しています…</p>
}

type Preview = { league: LeagueSummary; expires_at: string }
type Membership = { league_id: string; status: 'active' | 'left' | 'removed' }

export function JoinLeague({ groupNumber }: { groupNumber: string }) {
  const { subject } = useViewer()
  const [reset, setReset] = useState(0)
  useEffect(() => {
    const discard = () => setReset((n) => n + 1)
    window.addEventListener(inviteDiscarded, discard)
    return () => window.removeEventListener(inviteDiscarded, discard)
  }, [])
  return <JoinForm key={reset} groupNumber={groupNumber} subject={subject} />
}

function JoinForm({ groupNumber, subject }: { groupNumber: string; subject: string }) {
  const [code, setCode] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const checking = useRef(false)
  const [message, setMessage] = useState('')
  const action = useLeagueAction()
  useInviteLink(groupNumber, subject, (value) => {
    if (!value || checking.current || action.busy || action.retry) return
    setCode(value)
    setPreview(null)
    setMessage('')
  })

  function discardCode() {
    clearPendingInvite(groupNumber)
    setCode('')
    setPreview(null)
  }

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
      const format = error instanceof APIError && error.code === 'INVALID_INPUT'
      if (format || (error instanceof APIError && error.code === 'INVALID_INVITE')) discardCode()
      setMessage(format ? '参加コードの形式を確認してください。' : leagueMessage(error))
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
      if (reason === 'INVALID_INVITE' || reason === 'INVALID_INPUT') discardCode()
    })
    if (!result) return
    discardCode()
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
            clearPendingInvite(groupNumber)
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
