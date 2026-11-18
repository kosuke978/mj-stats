import Link from "next/link"
import { ParticipantLinks } from "@/components/matches/participant-links"
import { APIError } from "@/lib/auth/api"
import { referencePages } from "@/lib/auth/reference-pages"
import { serverAPI } from "@/lib/auth/server"
import type { League, Participant, ParticipantLink } from "@/types/match"

export default async function ParticipantLinksPage({ params }: { params: Promise<{ league_id: string }> }) {
  const { league_id } = await params
  const id = encodeURIComponent(league_id)
  const history = `/matches/league/${id}`
  const path = `${history}/participant-links`
  const api = `/api/leagues/${id}`
  let data
  let message: string | undefined
  try {
    data = await Promise.all([
      serverAPI<{ league: League }>(api, path),
      referencePages<Participant>(api, "participants", path),
      referencePages<ParticipantLink>(api, "participant-links", path),
    ])
  } catch (error) {
    if (!(error instanceof APIError || error instanceof TypeError)) throw error
    message = error instanceof APIError ? error.message : "申請を取得できませんでした。"
  }
  return (
    <main className="mx-auto w-full max-w-2xl space-y-5 px-4 py-6">
      <Link href={history} className="text-sm underline" prefetch={false}>対局履歴へ</Link>
      <h1 className="text-2xl font-bold">ゲストの本人紐付け</h1>
      {data ? <ParticipantLinks league={data[0].league} participants={data[1]} initial={data[2]} /> : <p role="alert">{message}</p>}
    </main>
  )
}
