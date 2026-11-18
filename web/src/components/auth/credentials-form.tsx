'use client'
import { useState } from 'react'
import Link from 'next/link'
import { browserSupabase } from '@/lib/supabase/browser'
import { safeReturnTo } from '@/lib/auth/paths'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type Mode = 'login' | 'signup' | 'reset'
export function CredentialsForm({
  mode,
  returnTo,
  origin,
}: {
  mode: Mode
  returnTo: string
  origin: string
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [message, setMessage] = useState('')
  const next = safeReturnTo(returnTo)
  const confirmationURL = `${origin}/auth/confirm?returnTo=${encodeURIComponent(next)}`
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    const supabase = browserSupabase()
    try {
      if (mode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        })
        if (error) {
          if (error.code === 'email_not_confirmed') {
            setWaiting(true)
            setMessage(
              'メールの確認が必要です。受信した確認リンクを開いてください。',
            )
          } else
            setMessage(
              error.status === 0 || (error.status ?? 0) >= 500
                ? '認証に接続できません。再試行してください。'
                : 'ログインできませんでした。メールとパスワードを確認してください。',
            )
          return
        }
        window.location.replace(next)
      } else if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: confirmationURL },
        })
        if (error) {
          setMessage(
            error.code === 'weak_password'
              ? 'より長いパスワードを入力してください。'
              : '登録を受け付けられませんでした。時間をおいて再試行してください。',
          )
          return
        }
        setWaiting(true)
        setPassword('')
        setMessage(
          '確認メールをご確認ください。リンクを開くと登録を続けられます。',
        )
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: confirmationURL,
        })
        if (error) {
          setMessage(
            '依頼を受け付けられませんでした。時間をおいて再試行してください。',
          )
          return
        }
        setWaiting(true)
        setMessage(
          '依頼を受け付けました。登録がある場合は、メールのリンクから再設定できます。届かない場合は時間をおいて再依頼してください。',
        )
      }
    } catch {
      setMessage('接続できませんでした。通信状態を確認して再試行してください。')
    } finally {
      setBusy(false)
    }
  }
  async function resend() {
    setBusy(true)
    setMessage('')
    try {
      const { error } = await browserSupabase().auth.resend({
        type: 'signup',
        email,
        options: { emailRedirectTo: confirmationURL },
      })
      setMessage(
        error
          ? '再送を受け付けられませんでした。時間をおいて再試行してください。'
          : '確認メールの再送を受け付けました。受信箱をご確認ください。',
      )
    } catch {
      setMessage('接続できませんでした。再試行してください。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-5">
      {next.startsWith('/join/') && (
        <p className="rounded-md border p-3 text-sm">
          手続き後に参加画面へ戻ります。招待リンクを開き直すか、受け取った参加コードを入力してください。
        </p>
      )}
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">メールアドレス</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            disabled={busy}
          />
        </div>
        {mode !== 'reset' && (
          <div className="space-y-2">
            <Label htmlFor="password">
              パスワード{mode === 'signup' ? '（8文字以上）' : ''}
            </Label>
            <Input
              id="password"
              type="password"
              autoComplete={
                mode === 'signup' ? 'new-password' : 'current-password'
              }
              minLength={mode === 'signup' ? 8 : undefined}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              disabled={busy}
            />
          </div>
        )}
        <p role="status" className="text-sm">
          {message}
        </p>
        <Button type="submit" disabled={busy} className="w-full">
          {busy
            ? '処理中…'
            : mode === 'login'
              ? 'ログイン'
              : mode === 'signup'
                ? '登録して確認メールを受け取る'
                : '再設定メールを依頼'}
        </Button>
        {waiting && mode !== 'reset' && (
          <Button
            type="button"
            variant="outline"
            disabled={busy || !email}
            onClick={() => void resend()}
            className="w-full"
          >
            確認メールを再送
          </Button>
        )}
      </form>
      <div className="flex flex-wrap gap-4 text-sm underline">
        {mode !== 'login' && (
          <Link href={`/login?returnTo=${encodeURIComponent(next)}`}>
            ログイン
          </Link>
        )}
        {mode !== 'signup' && (
          <Link href={`/signup?returnTo=${encodeURIComponent(next)}`}>
            新規登録
          </Link>
        )}
        {mode !== 'reset' && (
          <Link href={`/password/reset?returnTo=${encodeURIComponent(next)}`}>
            パスワードを忘れた場合
          </Link>
        )}
      </div>
    </div>
  )
}
