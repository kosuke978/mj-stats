export type League = {
  id: string
  name: string
  group_number: string
  my_role: "owner" | "admin" | "member"
}

export type Season = {
  id: string
  name: string
  start_date: string | null
  end_date: string | null
  version: string
}

export type ExactPoint = {
  numerator: string
  denominator: string
}

export type MatchHistoryResult = {
  user_id: string
  canonical_user_id: string
  display_name: string
  raw_score: number
  rank: number
  point: ExactPoint
}

export type MatchHistory = {
  id: string
  league_id: string
  rule_id: string
  season_id: string | null
  recorded_by: string
  status: "valid" | "cancelled"
  version: string
  match_date: string | null
  created_at: string | null
  results: MatchHistoryResult[]
}

export type GetMatchesResponse = {
  matches: MatchHistory[]
  next_cursor: string | null
}

export type Participant = {
  id: string
  name: string
  kind: "registered" | "guest"
  version: string
}

export type MatchRule = {
  id: string
  name: string
  default_points: number
  return_points: number
  uma: [number, number, number, number]
  calculation_version: string
  available: boolean
  version: string
}

export type ParticipantLink = {
  id: string
  league_id: string
  guest_user_id: string
  guest_name: string
  registered_user_id: string
  registered_name: string
  status: "pending" | "active" | "rejected" | "revoked"
  version: string
  consented_at: string
  reviewed_by: string | null
  reviewed_at: string | null
  confirmation_note: string | null
}

export type MatchScores = {
  rule_id: string
  players: { user_id: string; raw_score: number }[]
}

export type MatchSaveInput = MatchScores & {
  season_id: string | null
  match_date: string
  client_request_id: string
}
