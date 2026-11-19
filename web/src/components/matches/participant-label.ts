import type { Participant } from "@/types/match"

export function participantLabel(p: Participant, participants: Participant[]) {
  const sameName = participants.some((other) => other.id !== p.id && other.name === p.name)
  return `${p.name}${p.kind === "guest" ? "（ゲスト）" : ""}${sameName ? ` · ${p.id.slice(0, 8)}` : ""}`
}
