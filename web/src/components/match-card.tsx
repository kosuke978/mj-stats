import { CalendarDays } from "lucide-react"
import type { MatchHistory } from "@/types/match"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

const japanTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

export function MatchCard({ match }: { match: MatchHistory }) {
  const date = match.match_date ?? match.created_at
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
          <CalendarDays className="h-4 w-4 shrink-0" aria-hidden />
          {date ? (
            <time dateTime={date}>
              {match.match_date ? "対局日時" : "記録日時"} {japanTime.format(new Date(date))}
            </time>
          ) : "日時不明"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {match.results.map((player) => (
            <li key={player.user_id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <span className="min-w-0 wrap-anywhere">{player.rank}位 {player.display_name}</span>
              <span className="shrink-0 tabular-nums">
                {player.raw_score.toLocaleString("ja-JP")}点 · {player.point > 0 ? "+" : ""}{player.point.toFixed(1)} pt
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
