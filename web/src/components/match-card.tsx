import { format } from "date-fns"
import { CalendarDays } from "lucide-react"

import type { MatchHistory, MatchHistoryResult } from "@/types/match"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

type MatchCardProps = {
  match: MatchHistory
}

function getDisplayName(player: MatchHistoryResult) {
  if (!player.user_id) {
    return player.guest_name ?? "ゲスト"
  }

  return player.user_id
}

function formatPoint(point: number) {
  const fixedPoint = point.toFixed(1)
  return point > 0 ? `+${fixedPoint}` : fixedPoint
}

export function MatchCard({ match }: MatchCardProps) {
  const sortedResults = [...match.results].sort((a, b) => b.point - a.point)

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
          <CalendarDays className="h-4 w-4" />
          <span>{format(new Date(match.match_date), "yyyy/MM/dd HH:mm")}</span>
        </CardTitle>
      </CardHeader>

      <CardContent>
        <ul className="space-y-2">
          {sortedResults.map((player, index) => (
            <li
              key={`${match.id}-${player.user_id ?? player.guest_name ?? index}`}
              className="flex items-center justify-between rounded-md border px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{getDisplayName(player)}</span>
                {player.is_yakuman ? (
                  <Badge variant="destructive" className="text-[10px]">
                    役満
                  </Badge>
                ) : null}
                {player.is_tobi ? (
                  <Badge variant="secondary" className="text-[10px]">
                    トビ
                  </Badge>
                ) : null}
              </div>

              <span
                className={[
                  "text-sm font-semibold",
                  player.point >= 0 ? "text-blue-600" : "text-red-600",
                ].join(" ")}
              >
                {formatPoint(player.point)}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
