'use client'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { browserSupabase } from '@/lib/supabase/browser'
import { clientAPI } from '@/lib/auth/client-api'
import { type Viewer } from '@/lib/auth/api'
import { loginPath } from '@/lib/auth/paths'
import { Button } from '@/components/ui/button'

type ViewerState = { viewer: Viewer; setViewer: (viewer: Viewer) => void }
const ViewerContext = createContext<ViewerState | null>(null)
export function useViewer() {
  const state = useContext(ViewerContext)
  if (!state) throw new Error('本人情報を取得できません')
  return state
}
export function ViewerProvider({
  initial,
  subject,
  children,
}: {
  initial: Viewer
  subject: string
  children: ReactNode
}) {
  const [viewer, setViewer] = useState(initial)
  const [status, setStatus] = useState<
    'ready' | 'checking' | 'failed' | 'signed-out'
  >('ready')
  const path = usePathname()
  const generation = useRef(0)
  const invalidate = useCallback(() => {
    generation.current++
  }, [])
  const validate = useCallback(async () => {
    const attempt = ++generation.current
    setStatus('checking')
    try {
      const current = await clientAPI<Viewer>('/api/users/me')
      if (attempt !== generation.current) return
      setViewer(current)
      setStatus('ready')
    } catch {
      if (attempt === generation.current) setStatus('failed')
    }
  }, [])
  useEffect(() => {
    const supabase = browserSupabase()
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || (session && session.user.id !== subject)) {
        invalidate()
        setStatus('signed-out')
        // A full navigation discards SSR data, Router Cache and in-memory forms.
        window.location.replace(loginPath(path))
      }
    })
    const onVisible = () => {
      if (document.visibilityState === 'visible') void validate()
    }
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void validate()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      invalidate()
      subscription.unsubscribe()
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [path, subject, validate, invalidate])
  const progress =
    status !== 'ready' ? (
      <main
        className="mx-auto w-full max-w-lg space-y-4 p-6"
        aria-live="polite"
      >
        <p>
          {status === 'failed'
            ? '本人情報を確認できませんでした。'
            : '本人情報を確認しています…'}
        </p>
        {status === 'failed' && (
          <Button onClick={() => void validate()}>再試行</Button>
        )}
      </main>
    ) : null
  if (status === 'signed-out') return progress
  return (
    <ViewerContext.Provider value={{ viewer, setViewer }}>
      {progress}
      <div hidden={status !== 'ready'}>
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-3 px-4 pt-4 text-sm">
          <span>
            {viewer.profile_completed_at
              ? viewer.name
              : '表示名を設定してください'}
          </span>
          <Link className="underline" href="/account">
            アカウント
          </Link>
        </div>
        {children}
      </div>
    </ViewerContext.Provider>
  )
}
