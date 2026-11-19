import type { ExactPoint, MatchHistoryResult } from "@/types/match"

function displayPoint(point: ExactPoint) {
  const zero = BigInt(0)
  const one = BigInt(1)
  const ten = BigInt(10)
  const numerator = BigInt(point.numerator)
  const denominator = BigInt(point.denominator)
  const positive = numerator < zero ? -numerator : numerator
  const whole = positive / denominator
  let rest = positive % denominator
  let decimals = ""
  let test = denominator
  for (const factor of [BigInt(2), BigInt(5)]) {
    while (test % factor === zero) test /= factor
  }
  const terminating = test === one
  while (rest !== zero && (terminating || decimals.length < 4)) {
    rest *= ten
    decimals += (rest / denominator).toString()
    rest %= denominator
  }
  const sign = numerator < zero ? "−" : numerator > zero ? "+" : ""
  return `${sign}${whole}${decimals ? `.${decimals}` : ""}${rest ? "…" : ""}`
}

export function ResultList({ results, detailed = false }: { results: MatchHistoryResult[]; detailed?: boolean }) {
  const names = new Map<string, number>()
  for (const result of results) names.set(result.display_name, (names.get(result.display_name) ?? 0) + 1)
  return (
    <ul className="space-y-2">
      {results.map((player) => (
        <li key={player.user_id} className="rounded-md border px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 wrap-anywhere">
              {player.rank}位 {player.display_name}
              {(names.get(player.display_name) ?? 0) > 1 && ` (${player.user_id.slice(0, 8)})`}
            </span>
            <span className="min-w-0 tabular-nums wrap-anywhere">
              {player.raw_score.toLocaleString("ja-JP")}点 · {displayPoint(player.point)} pt
            </span>
          </div>
          {detailed && (
            <details className="mt-1 text-xs">
              <summary className="cursor-pointer">正確な値と参加者ID</summary>
              <dl className="grid gap-1 break-all py-2">
                <div><dt className="font-medium">ポイント</dt><dd>{player.point.numerator}/{player.point.denominator} pt</dd></div>
                <div><dt className="font-medium">原参加者ID</dt><dd>{player.user_id}</dd></div>
                {player.user_id !== player.canonical_user_id &&
                  <div><dt className="font-medium">本人紐付け先ID</dt><dd>{player.canonical_user_id}</dd></div>}
              </dl>
            </details>
          )}
        </li>
      ))}
    </ul>
  )
}
