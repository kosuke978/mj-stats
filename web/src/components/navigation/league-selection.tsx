'use client'

import { useEffect } from 'react'
import { useViewer } from '@/components/auth/viewer-provider'
import { leagueHistory } from '@/lib/leagues/paths'
import type { League } from '@/types/match'

const selectionKey = 'mjstats.selected-league'

export function RememberLeague({ id }: { id: string }) {
  const { viewer } = useViewer()
  useEffect(() => {
    try {
      sessionStorage.setItem(selectionKey, JSON.stringify({ viewer: viewer.id, id }))
    } catch {
      // All league links work without browser storage.
    }
  }, [id, viewer.id])
  return null
}

export function ResumeLegacyRoute({ leagues, entry }: { leagues: League[]; entry: boolean }) {
  const { viewer } = useViewer()
  useEffect(() => {
    let selected: League | undefined
    try {
      const saved = JSON.parse(sessionStorage.getItem(selectionKey) ?? 'null')
      if (saved?.viewer === viewer.id) {
        selected = leagues.find(({ id }) => id === saved.id)
        if (!selected) sessionStorage.removeItem(selectionKey)
      }
    } catch {
      // An absent or unreadable selection leaves the league chooser available.
    }
    selected ??= leagues.length === 1 ? leagues[0] : undefined
    if (selected) window.location.replace(leagueHistory(selected.id) + (entry ? '/new' : ''))
  }, [entry, leagues, viewer.id])
  return null
}
