export type MatchHistoryResult = {
  user_id: string | null
  guest_name: string | null
  score: number
  point: number
  is_yakuman: boolean
  is_tobi: boolean
}

export type MatchHistory = {
  id: string
  match_date: string
  rule_id: string
  created_at: string
  results: MatchHistoryResult[]
}

export type GetMatchesResponse = {
  matches: MatchHistory[]
}
