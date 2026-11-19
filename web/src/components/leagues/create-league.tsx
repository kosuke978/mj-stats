'use client'

import { useState } from 'react'
import { leagueHome } from '@/lib/leagues/paths'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { type LeagueSummary, useLeagueAction } from './league-api'

export function CreateLeague() {
  const [name, setName] = useState('')
  const action = useLeagueAction()

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const result = await action.run<{ league: LeagueSummary }>(action.retry ? null : {
      path: '/api/leagues',
      body: { name, client_request_id: crypto.randomUUID() },
    })
    if (result) window.location.assign(leagueHome(result.league.id))
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border p-4">
      <div className="grid gap-2">
        <Label htmlFor="league-name">リーグ名</Label>
        <Input id="league-name" value={name} onChange={(e) => setName(e.target.value)}
          disabled={action.busy || action.retry} required />
      </div>
      <p className="text-sm text-muted-foreground">作成したリーグは検索に掲載されません。</p>
      <Button type="submit" size="lg" disabled={action.busy}>
        {action.retry ? '作成を再試行' : 'リーグを作成'}
      </Button>
      {action.message && <p role="alert" className="text-sm">{action.message}</p>}
    </form>
  )
}
