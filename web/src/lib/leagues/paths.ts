export function leagueHome(id: string) {
  return `/leagues/${encodeURIComponent(id)}`
}

export function leagueHistory(id: string) {
  return `/matches/league/${encodeURIComponent(id)}`
}
