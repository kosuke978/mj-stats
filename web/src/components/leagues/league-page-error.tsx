import { AppLink, navLink } from "@/components/navigation/app-link"
import { APIError } from "@/lib/auth/api"

export function LeaguePageError({ error, path, back }: { error: unknown; path: string; back: string }) {
  if (!(error instanceof APIError || error instanceof TypeError)) throw error
  const denied = error instanceof APIError && error.status === 403
  const missing = error instanceof APIError && [400, 404].includes(error.status)
  return (
    <>
      <p role="alert">{denied ? "このページを閲覧する権限がありません。" : missing ? "指定した対象を確認できませんでした。" : "取得に失敗しました。"}</p>
      <div className="flex flex-wrap gap-2">
        <AppLink className={navLink} href={back}>戻る</AppLink>
        {!denied && <AppLink className={navLink} href={path}>{missing ? "最初から表示" : "再試行"}</AppLink>}
      </div>
    </>
  )
}

export async function loadLeaguePage<T>(load: () => Promise<T>): Promise<{ data: T; error?: never } | { data?: never; error: APIError | TypeError }> {
  try {
    return { data: await load() }
  } catch (error) {
    if (!(error instanceof APIError || error instanceof TypeError)) throw error
    return { error }
  }
}
