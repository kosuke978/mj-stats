'use client'

import { useRef, useState } from 'react'
import { AppLink } from '@/components/navigation/app-link'
import { useViewer } from '@/components/auth/viewer-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { clientAPI } from '@/lib/auth/client-api'
import { leagueMessage, type LeagueSummary } from './league-api'

type Results = { leagues: LeagueSummary[]; next_cursor: string | null }
type SearchPage = Results & { q: string }

export function FindLeague() {
  const { subject } = useViewer()
  const [number, setNumber] = useState('')
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchPage | null>(null)
  const [busy, setBusy] = useState<'number' | 'search' | null>(null)
  const lock = useRef(false)
  const [error, setError] = useState('')

  async function search(term: string, cursor?: string) {
    if (lock.current) return
    lock.current = true
    setBusy('search')
    setError('')
    if (!cursor) setResults(null)
    const params = new URLSearchParams({ q: term })
    if (cursor) params.set('cursor', cursor)
    try {
      const response = await clientAPI<Results>(`/api/leagues/search?${params}`, {}, subject)
      setResults((previous) => ({
        ...response,
        q: term,
        leagues: cursor && previous ? [...previous.leagues, ...response.leagues] : response.leagues,
      }))
    } catch (e) {
      setError(leagueMessage(e))
    } finally {
      lock.current = false
      setBusy(null)
    }
  }

  async function resolve(event: React.FormEvent) {
    event.preventDefault()
    if (lock.current) return
    lock.current = true
    setBusy('number')
    setError('')
    try {
      const { league } = await clientAPI<{ league: LeagueSummary }>('/api/leagues/resolve', {
        method: 'POST',
        body: JSON.stringify({ group_number: number }),
      }, subject)
      window.location.assign(`/join/${league.group_number}`)
    } catch (e) {
      setError(leagueMessage(e))
    } finally {
      lock.current = false
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="font-semibold">番号から参加</h2>
        <form onSubmit={resolve} className="grid gap-2">
          <Label htmlFor="league-number">12桁のグループ番号</Label>
          <Input id="league-number" type="text" inputMode="numeric" value={number}
            onChange={(e) => setNumber(e.target.value)} required disabled={!!busy} />
          <Button type="submit" size="lg" disabled={!!busy}>番号で探す</Button>
        </form>
      </section>
      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="font-semibold">名前から参加</h2>
        <form onSubmit={(e) => { e.preventDefault(); void search(q) }} className="grid gap-2">
          <Label htmlFor="league-query">公開されているリーグ名</Label>
          <Input id="league-query" type="search" value={q} onChange={(e) => setQ(e.target.value)}
            required disabled={!!busy} />
          <Button type="submit" size="lg" disabled={!!busy}>名前で検索</Button>
        </form>
        {results?.leagues.length === 0 && <p role="status" className="text-sm">該当するリーグはありません。</p>}
        {!!results?.leagues.length && (
          <ul className="divide-y rounded-md border">
            {results.leagues.map((l) => (
              <li key={l.id}>
                <AppLink href={`/join/${l.group_number}`}
                  className="flex flex-wrap items-baseline justify-between gap-2 p-3 hover:bg-muted">
                  <span className="wrap-anywhere">{l.name}</span>
                  <span className="font-mono text-sm text-muted-foreground">{l.group_number}</span>
                </AppLink>
              </li>
            ))}
          </ul>
        )}
        {results?.next_cursor && <Button type="button" variant="outline" disabled={!!busy}
          onClick={() => void search(results.q, results.next_cursor ?? undefined)}>さらに表示</Button>}
      </section>
      {error && <p role="alert" className="text-sm">{error}</p>}
    </div>
  )
}
