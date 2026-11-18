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

export type MatchHistoryResult = {
  user_id: string
  display_name: string
  raw_score: number
  rank: number
  point: number
}

export type MatchHistory = {
  id: string
  league_id: string
  rule_id: string
  season_id: string | null
  recorded_by: string
  match_date: string | null
  created_at: string | null
  results: MatchHistoryResult[]
}

export type GetMatchesResponse = {
  matches: MatchHistory[]
  next_cursor: string | null
}
