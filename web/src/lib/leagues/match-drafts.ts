import type { MatchSaveInput } from '@/types/match'

export type MatchDraft = {
  rule: string
  season: string
  date: string
  players: { id: string; score: string }[]
  pending: MatchSaveInput | null
}
export type StoredDraft = { draft: MatchDraft; expiresAt: number }

export const draftLifetime = 24 * 60 * 60 * 1000
export const draftsUpdated = 'mjstats:drafts-updated'
export const draftLogout = 'mjstats.match-entry.logout'
export const explicitTabLogout = 'mjstats:explicit-tab-logout'
const ownerKey = 'mjstats.match-entry.owner'
const sessionKey = 'mjstats.match-entry.session'
const prefix = 'mjstats.match-entry.v2:'
const previousPrefix = 'mjstats.match-entry.v1:'

export function matchDraftKey(subject: string, viewer: string, league: string) {
  return `${prefix}${subject}:${viewer}:${league}`
}

function draftKeys() {
  return Object.keys(sessionStorage).filter((key) => key.startsWith(prefix) || key.startsWith(previousPrefix))
}

function parseDraft(key: string): StoredDraft | null {
  try {
    const stored = JSON.parse(sessionStorage.getItem(key) ?? 'null') as StoredDraft | null
    return stored && Number.isFinite(stored.expiresAt) && Array.isArray(stored.draft?.players)
      && stored.draft.players.length === 4 ? stored : null
  } catch {
    return null
  }
}

export function readMatchDraft(key: string): StoredDraft | null {
  const stored = parseDraft(key)
  return stored && stored.expiresAt > Date.now() ? stored : null
}

export function draftSessionID(token: string): string | null {
  try {
    const { session_id } = JSON.parse(atob(token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/')))
    return typeof session_id === 'string' ? session_id : null
  } catch {
    return null
  }
}

export function writeMatchDraft(key: string, subject: string, value: StoredDraft) {
  try {
    if (sessionStorage.getItem(ownerKey) !== subject || value.expiresAt <= Date.now()) return
    sessionStorage.setItem(key, JSON.stringify(value))
    window.dispatchEvent(new Event(draftsUpdated))
  } catch {
    // A blocked storage API leaves the current form usable in memory.
  }
}

export function deleteMatchDraft(key: string) {
  try {
    sessionStorage.removeItem(key)
    window.dispatchEvent(new Event(draftsUpdated))
  } catch {}
}

export function setDraftOwner(subject: string, sessionID: string | null) {
  try {
    const previous = sessionStorage.getItem(ownerKey)
    if (previous !== subject) {
      draftKeys().forEach((key) => sessionStorage.removeItem(key))
      sessionStorage.setItem(ownerKey, subject)
    }
    if (sessionID) sessionStorage.setItem(sessionKey, sessionID)
    else sessionStorage.removeItem(sessionKey)
  } catch {}
}

function clearDrafts() {
  draftKeys().forEach((key) => sessionStorage.removeItem(key))
  sessionStorage.removeItem(ownerKey)
  sessionStorage.removeItem(sessionKey)
  window.dispatchEvent(new Event(draftsUpdated))
}

export function discardMatchDrafts(subject: string, sessionID: string | null) {
  try {
    if (sessionStorage.getItem(ownerKey) === subject) clearDrafts()
  } catch {}
  if (sessionID) {
    try {
      localStorage.setItem(draftLogout, sessionID)
      localStorage.removeItem(draftLogout)
    } catch {}
  }
}

export function discardDraftsForSession(sessionID: string) {
  try {
    if (sessionStorage.getItem(sessionKey) === sessionID) {
      clearDrafts()
      window.dispatchEvent(new Event(explicitTabLogout))
    }
  } catch {}
}

export function sweepMatchDrafts(): number | null {
  let nextExpiry: number | null = null
  try {
    const owner = sessionStorage.getItem(ownerKey)
    for (const key of draftKeys()) {
      const value = owner && key.startsWith(prefix + owner + ':') ? readMatchDraft(key) : null
      if (!value) sessionStorage.removeItem(key)
      else nextExpiry = Math.min(nextExpiry ?? value.expiresAt, value.expiresAt)
    }
  } catch {}
  return nextExpiry
}
