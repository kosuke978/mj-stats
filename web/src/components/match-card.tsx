import { AppLink } from "@/components/navigation/app-link"
import { ResultList } from "@/components/matches/result-list"
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

export function MatchCard({ match, detailURL }: { match: MatchHistory; detailURL?: string }) {
  const date = match.match_date ?? match.created_at
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
          <CalendarDays className="h-4 w-4 shrink-0" aria-hidden />
          {date ? (
            <time className="min-w-0 wrap-anywhere" dateTime={date}>
              {match.match_date ? "対局日時" : "記録日時"} {japanTime.format(new Date(date))}
            </time>
          ) : "日時不明"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ResultList results={match.results} detailed={!detailURL} />
        {detailURL && <AppLink className="mt-3 inline-block text-sm underline" href={detailURL}>対局詳細</AppLink>}
      </CardContent>
    </Card>
  )
}
