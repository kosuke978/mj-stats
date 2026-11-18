import "server-only"
import { serverAPI } from "./server"

export async function referencePages<T>(endpoint: string, list: string, returnTo: string, filters: Record<string, string> = {}): Promise<T[]> {
  const items: T[] = []
  let cursor: string | null = null
  do {
    const query = new URLSearchParams({ ...filters, limit: "100" })
    if (cursor) query.set("cursor", cursor)
    const page: { [key: string]: T[] | string | null; next_cursor: string | null } =
      await serverAPI(`${endpoint}/${list}?${query}`, returnTo)
    const data = page[list.replaceAll("-", "_")]
    if (!Array.isArray(data)) throw new TypeError("参照データを取得できませんでした。")
    items.push(...data)
    cursor = page.next_cursor
  } while (cursor)
  return items
}
