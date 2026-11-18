// A tab-local handoff across full-page login, confirmation and profile setup.
const key = 'mjstats.pending-invite'
const lifetime = 15 * 60_000
export const inviteUpdated = 'mjstats:pending-invite-updated'
export const inviteDiscarded = 'mjstats:pending-invite-discarded'

type PendingInvite = {
  groupNumber: string
  code: string
  subject: string | null
  expiresAt: number
}

function read(): PendingInvite | null {
  try {
    const raw = window.sessionStorage.getItem(key)
    if (!raw) return null
    const invite = JSON.parse(raw)
    if (!/^[0-9]{12}$/.test(invite.groupNumber) ||
      typeof invite.code !== 'string' || !invite.code || invite.code.length > 64 ||
      !(invite.subject === null || typeof invite.subject === 'string') ||
      typeof invite.expiresAt !== 'number' || !Number.isFinite(invite.expiresAt)) return null
    return invite
  } catch {
    return null
  }
}

function write(invite: PendingInvite) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(invite))
    window.dispatchEvent(new Event(inviteUpdated))
  } catch {
    // Storage can be unavailable. The join screen still supports manual entry.
  }
}

export function clearPendingInvite(groupNumber?: string) {
  if (groupNumber && read()?.groupNumber !== groupNumber) return
  try {
    window.sessionStorage.removeItem(key)
  } catch {
    // The browser may disable tab storage.
  }
}

export function captureInvite(groupNumber: string, code: string, subject: string | null) {
  write({ groupNumber, code, subject, expiresAt: Date.now() + lifetime })
}

export function restoreInvite(groupNumber: string, subject: string | null) {
  const invite = read()
  if (!invite) return null
  if (invite.groupNumber !== groupNumber || invite.expiresAt <= Date.now() ||
    (invite.subject && invite.subject !== subject)) {
    clearPendingInvite()
    return null
  }
  if (subject && !invite.subject) write({ ...invite, subject })
  return invite.code
}

function discardPendingInvite() {
  clearPendingInvite()
  window.dispatchEvent(new Event(inviteDiscarded))
}

export function updateInviteSubject(subject: string | null) {
  const invite = read()
  if (!invite) return
  if ((invite.subject && invite.subject !== subject) || invite.expiresAt <= Date.now()) {
    discardPendingInvite()
  } else if (subject && !invite.subject) {
    write({ ...invite, subject })
  }
}

export function discardInviteOnLogout() {
  discardPendingInvite()
}

export function inviteExpiry() {
  const invite = read()
  if (!invite) return null
  if (invite.expiresAt <= Date.now()) {
    discardPendingInvite()
    return null
  }
  return invite.expiresAt
}
