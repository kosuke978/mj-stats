import { AppLink, navLink } from "@/components/navigation/app-link"

export function AuditNavigation({ path, back, cursor, next }: { path: string; back: string; cursor?: string; next: string | null }) {
  return <nav aria-label="記録のページ" className="flex flex-wrap gap-2">
    <AppLink className={navLink} href={back}>戻る</AppLink>
    {cursor && <AppLink className={navLink} href={path}>最初のページ</AppLink>}
    {next && <AppLink className={navLink} href={`${path}?cursor=${encodeURIComponent(next)}`}>次のページ</AppLink>}
  </nav>
}

export function AuditHeader({ label, actor, date, reason }: { label: string; actor: string; date: string; reason: string | null }) {
  return <header className="space-y-1">
    <h2 className="font-semibold">{label}</h2>
    <p className="text-sm"><time dateTime={date}>{new Intl.DateTimeFormat("ja-JP", {
      dateStyle: "medium", timeStyle: "medium", timeZone: "Asia/Tokyo",
    }).format(new Date(date))}</time>（日本時間）</p>
    <p className="text-sm wrap-anywhere">操作者ID {actor}</p>
    {reason && <p className="whitespace-pre-wrap wrap-anywhere">理由 {reason}</p>}
  </header>
}
