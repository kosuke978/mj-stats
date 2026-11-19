'use client'
import { useState } from 'react'
import { clientAPI } from '@/lib/auth/client-api'
import { type Viewer } from '@/lib/auth/api'
import { normalizeName } from '@/lib/auth/name'
import { safeReturnTo } from '@/lib/auth/paths'
import { discardInviteOnLogout } from '@/lib/auth/pending-invite'
import { browserSupabase } from '@/lib/supabase/browser'
import { useViewer } from './viewer-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function ProfileForm({
  setup = false,
  returnTo = '/',
}: {
  setup?: boolean
  returnTo?: string
}) {
  const { viewer, setViewer, subject } = useViewer()
  const [name, setName] = useState(setup ? '' : viewer.name)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setMessage('')
    const normalized = normalizeName(name)
    if (normalized === null) {
      setMessage(
        '前後の空白を除き1〜30文字で入力してください。改行・制御文字は使えません。',
      )
      return
    }
    setBusy(true)
    try {
      const updated = await clientAPI<Viewer>('/api/users/me', {
        method: 'PATCH',
        body: JSON.stringify({ name: normalized }),
      }, subject)
      setViewer(updated)
      setName(updated.name)
      if (setup) window.location.replace(safeReturnTo(returnTo))
      else setMessage('表示名を変更しました。')
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : '保存に失敗しました。再試行してください。',
      )
    } finally {
      setBusy(false)
    }
  }
  async function logout() {
    setBusy(true)
    setMessage('')
    try {
      const { error } = await browserSupabase().auth.signOut({ scope: 'local' })
      if (error) {
        setMessage('ログアウトを完了できませんでした。再試行してください。')
        return
      }
      discardInviteOnLogout()
      window.location.replace('/login')
    } catch {
      setMessage('ログアウトを完了できませんでした。再試行してください。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="display-name">表示名</Label>
          <Input
            id="display-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            aria-describedby="name-help profile-message"
            autoComplete="nickname"
            disabled={busy}
          />
          <p id="name-help" className="text-sm text-muted-foreground">
            1〜30文字。同じ名前の人がいても利用できます。
          </p>
        </div>
        <Button type="submit" disabled={busy}>
          {busy ? '保存中…' : setup ? '表示名を設定して進む' : '表示名を変更'}
        </Button>
      </form>
      <p id="profile-message" role="status">
        {message}
      </p>
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={() => void logout()}
      >
        このブラウザからログアウト
      </Button>
    </div>
  )
}
