'use client'

import { useEffect } from 'react'
import { browserSupabase } from '@/lib/supabase/browser'
import {
  discardInviteOnLogout,
  inviteExpiry,
  inviteUpdated,
  updateInviteSubject,
} from '@/lib/auth/pending-invite'

export function InviteLifecycle() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    function schedule() {
      clearTimeout(timer)
      const expiresAt = inviteExpiry()
      if (expiresAt !== null) timer = setTimeout(schedule, Math.max(0, expiresAt - Date.now()))
    }
    const { data: { subscription } } = browserSupabase().auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') discardInviteOnLogout()
      else if (event === 'INITIAL_SESSION' || session) updateInviteSubject(session?.user.id ?? null)
    })
    window.addEventListener(inviteUpdated, schedule)
    window.addEventListener('pageshow', schedule)
    schedule()
    return () => {
      clearTimeout(timer)
      subscription.unsubscribe()
      window.removeEventListener(inviteUpdated, schedule)
      window.removeEventListener('pageshow', schedule)
    }
  }, [])
  return null
}
