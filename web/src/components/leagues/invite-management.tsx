'use client'

import { useEffect, useRef, useState } from 'react'
import { useViewer } from '@/components/auth/viewer-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { clientAPI } from '@/lib/auth/client-api'
import { leagueMessage, type Post, useLeagueAction } from './league-api'

type Invite = {
  id: string
  expires_at: string
  version: string
  status: 'active' | 'expired' | 'revoked'
  code?: string
  join_url?: string
}

export function InviteManagement({ leagueID }: { leagueID: string }) {
  const { subject } = useViewer()
  const [invite, setInvite] = useState<Invite | null | undefined>()
  const [loading, setLoading] = useState(false)
  const checking = useRef(false)
  const [message, setMessage] = useState('')
  const [copied, setCopied] = useState(false)
  const action = useLeagueAction()
  const base = `/api/leagues/${leagueID}/invites`
  const displayed = invite?.status === 'active' ? invite : null

  useEffect(() => {
    if (!invite || invite.status !== 'active') return
    const timer = setTimeout(() => setInvite(null), Math.max(0, Date.parse(invite.expires_at) - Date.now()))
    return () => clearTimeout(timer)
  }, [invite])

  async function load() {
    if (checking.current || action.busy || action.retry) return
    checking.current = true
    setLoading(true)
    setCopied(false)
    setMessage('')
    setInvite(undefined)
    try {
      const result = await clientAPI<{ invite: Invite | null }>(base + '/current', {}, subject)
      setInvite(result.invite)
    } catch (error) {
      setMessage(leagueMessage(error))
    } finally {
      checking.current = false
      setLoading(false)
    }
  }

  async function change(target: Invite | null) {
    if (checking.current || action.busy) return
    setCopied(false)
    setMessage('')
    setInvite(undefined)
    const requestID = crypto.randomUUID()
    const post: Post = target
      ? { path: base + '/' + target.id + '/revoke', body: { client_request_id: requestID, version: target.version } }
      : { path: base, body: { client_request_id: requestID } }
    const result = await action.run<{ invite: Invite }>(action.retry ? null : post)
    if (result) {
      setInvite(result.invite.status === 'active' ? result.invite : null)
      if (result.invite.status === 'revoked') setMessage('この招待は失効しました。')
      if (result.invite.status === 'expired') setMessage('この招待は期限切れです。')
    }
  }

  async function copy() {
    if (!displayed?.join_url) return
    try {
      await navigator.clipboard.writeText(displayed.join_url)
      setCopied(true)
    } catch {
      setMessage('リンクを選択してコピーしてください。')
    }
  }

  const busy = loading || action.busy
  return (
    <section className="space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="lg" variant="outline" onClick={() => void load()} disabled={busy || action.retry}>
          現行の招待を取得
        </Button>
        <Button type="button" size="lg" onClick={() => void change(null)} disabled={busy}>
          {action.retry ? '同じ操作を再試行' : displayed ? '招待を再発行' : '招待を発行'}
        </Button>
        {displayed && <Button type="button" size="lg" variant="destructive" onClick={() => void change(displayed)} disabled={busy}>
          この招待を失効
        </Button>}
      </div>
      <p className="text-sm text-muted-foreground">招待は7日間有効です。再発行すると以前の招待は使えなくなります。</p>
      {loading && <p role="status">取得中…</p>}
      {invite === null && <p role="status">有効な招待はありません。</p>}
      {displayed?.code && displayed.join_url && (
        <div className="grid gap-2">
          <Label htmlFor="managed-invite-code">参加コード</Label>
          <Input id="managed-invite-code" value={displayed.code} readOnly className="font-mono" />
          <Label htmlFor="managed-invite-link">招待リンク</Label>
          <Input id="managed-invite-link" value={displayed.join_url} readOnly />
          <Button type="button" variant="outline" onClick={() => void copy()}>
            招待リンクをコピー
          </Button>
          {copied && <p role="status" className="text-sm">リンクをコピーしました。</p>}
          <p className="text-sm">期限 {new Intl.DateTimeFormat('ja-JP', {
            dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tokyo',
          }).format(new Date(displayed.expires_at))}（日本時間）</p>
        </div>
      )}
      {action.message && <p role="alert" className="text-sm">{action.message}</p>}
      {message && <p role="status" className="text-sm">{message}</p>}
    </section>
  )
}
