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
import { usePathname } from 'next/navigation'
import { AppLink, navLink } from '@/components/navigation/app-link'
import { browserSupabase } from '@/lib/supabase/browser'
import { clientAPI } from '@/lib/auth/client-api'
import { APIError, type Viewer } from '@/lib/auth/api'
import { loginPath } from '@/lib/auth/paths'
import { discardInviteOnLogout } from '@/lib/auth/pending-invite'
import { discardMatchDrafts, draftSessionID, explicitTabLogout } from '@/lib/leagues/match-drafts'
import { Button } from '@/components/ui/button'

type ViewerState = {
  viewer: Viewer
  subject: string
  setViewer: (viewer: Viewer) => void
  signOut: () => Promise<void>
}
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
  const signingOut = useRef(false)
  const protectedContent = useRef<HTMLDivElement>(null)
  const invalidate = useCallback(() => {
    generation.current++
  }, [])
  const validate = useCallback(async () => {
    const attempt = ++generation.current
    setStatus('checking')
    try {
      const current = await clientAPI<Viewer>('/api/users/me', {}, subject)
      if (attempt !== generation.current) return
      if (current.id !== initial.id) {
        window.location.reload()
        return
      }
      setViewer(current)
      setStatus('ready')
    } catch (error) {
      if (attempt === generation.current) {
        setStatus(error instanceof APIError && error.status === 401 ? 'signed-out' : 'failed')
      }
    }
  }, [initial.id, subject])
  async function signOut() {
    signingOut.current = true
    try {
      const supabase = browserSupabase()
      const { data: { session } } = await supabase.auth.getSession()
      const { error } = await supabase.auth.signOut({ scope: 'local' })
      if (error) throw error
      discardInviteOnLogout()
      discardMatchDrafts(subject, session ? draftSessionID(session.access_token) : null)
      window.location.replace('/login')
    } finally {
      signingOut.current = false
    }
  }
  useEffect(() => {
    const supabase = browserSupabase()
    let reauthentication: number | undefined
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || (event === 'INITIAL_SESSION' && !session)) {
        invalidate()
        setStatus('signed-out')
        if (!signingOut.current) {
          reauthentication = window.setTimeout(() => window.location.replace(loginPath(path)), 0)
        }
      } else if (session && session.user.id !== subject) {
        invalidate()
        setStatus('signed-out')
        window.location.reload()
      }
    })
    const onVisible = () => {
      if (document.visibilityState === 'visible') void validate()
    }
    const onPageHide = () => {
      // Keep a frozen document from displaying protected data during restoration.
      if (protectedContent.current) protectedContent.current.hidden = true
    }
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload()
    }
    const onExplicitLogout = () => window.location.replace(loginPath(path))
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    window.addEventListener(explicitTabLogout, onExplicitLogout)
    return () => {
      invalidate()
      window.clearTimeout(reauthentication)
      subscription.unsubscribe()
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
      window.removeEventListener(explicitTabLogout, onExplicitLogout)
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
            : status === 'signed-out' ? 'ログインし直してください。' : '本人情報を確認しています…'}
        </p>
        {status === 'failed' && (
          <Button onClick={() => void validate()}>再試行</Button>
        )}
        {status === 'signed-out' && <AppLink className={navLink} href={loginPath(path)}>ログイン</AppLink>}
      </main>
    ) : null
  if (status === 'signed-out') return progress
  return (
    <ViewerContext.Provider value={{ viewer, setViewer, subject, signOut }}>
      {progress}
      <div ref={protectedContent} hidden={status !== 'ready'}>
        <header className="border-b">
          <div className="mx-auto flex w-full max-w-2xl flex-wrap items-center gap-x-4 px-4 py-1 text-sm">
            <span className="font-semibold">MJ-Stats</span>
            {viewer.profile_completed_at && (
              <nav aria-label="メインナビゲーション" className="flex flex-wrap gap-x-1">
                <AppLink className={navLink} href="/" aria-current={path === '/' ? 'page' : undefined}>ホーム</AppLink>
                <AppLink className={navLink} href="/leagues/search" aria-current={path === '/leagues/search' ? 'page' : undefined}>リーグに参加</AppLink>
                <AppLink className={navLink} href="/account" aria-current={path === '/account' ? 'page' : undefined}>アカウント</AppLink>
              </nav>
            )}
            {viewer.profile_completed_at && <span className="min-w-0 py-1 text-muted-foreground wrap-anywhere">{viewer.name}</span>}
          </div>
        </header>
        {children}
      </div>
    </ViewerContext.Provider>
  )
}
