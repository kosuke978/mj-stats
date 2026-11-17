'use client'
import { useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
export function PasswordForm() {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [done, setDone] = useState(false)
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    try {
      const response = await fetch('/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        cache: 'no-store',
      })
      const data = await response.json()
      setMessage(data.message)
      if (response.ok) {
        setPassword('')
        setDone(true)
      }
    } catch {
      setMessage('通信に失敗しました。再試行してください。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-4">
      {!done && (
        <form onSubmit={submit} className="space-y-4">
          <Label htmlFor="new-password">新しいパスワード（8文字以上）</Label>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={8}
            required
            disabled={busy}
          />
          <Button type="submit" disabled={busy}>
            {busy ? '更新中…' : 'パスワードを更新'}
          </Button>
        </form>
      )}
      <p role="status">{message}</p>
      <Link
        className="inline-block underline"
        href={done ? '/matches' : '/password/reset'}
      >
        {done ? 'MJ-Stats に戻る' : '新しい再設定メールを依頼'}
      </Link>
    </div>
  )
}
