'use client'

import { useEffect } from 'react'
import {
  discardDraftsForSession, draftLogout, draftSessionID, draftsUpdated, setDraftOwner, sweepMatchDrafts,
} from '@/lib/leagues/match-drafts'
import { browserSupabase } from '@/lib/supabase/browser'

export function MatchDraftLifecycle() {
  useEffect(() => {
    let timer: number | undefined
    function schedule() {
      window.clearTimeout(timer)
      const expiry = sweepMatchDrafts()
      if (expiry !== null) timer = window.setTimeout(schedule, Math.max(0, expiry - Date.now()))
    }
    const { data: { subscription } } = browserSupabase().auth.onAuthStateChange((_event, session) => {
      // A failed refresh may also emit SIGNED_OUT. Its draft can survive reauthentication.
      if (session) setDraftOwner(session.user.id, draftSessionID(session.access_token))
      schedule()
    })
    function onStorage(event: StorageEvent) {
      if (event.key === draftLogout && event.newValue) discardDraftsForSession(event.newValue)
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener('pageshow', schedule)
    window.addEventListener(draftsUpdated, schedule)
    document.addEventListener('visibilitychange', schedule)
    schedule()
    return () => {
      window.clearTimeout(timer)
      subscription.unsubscribe()
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('pageshow', schedule)
      window.removeEventListener(draftsUpdated, schedule)
      document.removeEventListener('visibilitychange', schedule)
    }
  }, [])
  return null
}
