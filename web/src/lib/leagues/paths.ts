export function leagueHome(id: string) {
  return `/leagues/${encodeURIComponent(id)}`
}

export function leagueHistory(id: string) {
  return `/matches/league/${encodeURIComponent(id)}`
}

export const leagueRoles = { owner: "オーナー", admin: "管理者", member: "メンバー" }
