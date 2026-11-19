import { buttonVariants } from '@/components/ui/button'
import { leagueHistory, leagueHome } from '@/lib/leagues/paths'
import { AppLink, navLink } from './app-link'
import { RememberLeague } from './league-selection'

export function LeagueActions() {
  return (
    <div className="flex flex-wrap gap-3">
      <AppLink href="/leagues/new" className={buttonVariants({ size: 'lg' }) + ' min-h-11'}>リーグを作成</AppLink>
      <AppLink href="/leagues/search" className={buttonVariants({ variant: 'outline', size: 'lg' }) + ' min-h-11'}>名前・番号から参加</AppLink>
    </div>
  )
}

export function LeagueNavigation({ id, active }: { id: string; active?: 'home' | 'entry' | 'history' | 'ranking' }) {
  const history = leagueHistory(id)
  return (
    <nav aria-label="リーグ内の操作" className="flex flex-wrap gap-x-2 text-sm">
      <RememberLeague id={id} />
      <AppLink className={navLink} href={leagueHome(id)} aria-current={active === 'home' ? 'page' : undefined}>リーグホーム</AppLink>
      <AppLink className={navLink} href={`${history}/new`} aria-current={active === 'entry' ? 'page' : undefined}>対局を入力</AppLink>
      <AppLink className={navLink} href={history} aria-current={active === 'history' ? 'page' : undefined}>対局履歴</AppLink>
      <AppLink className={navLink} href={`${leagueHome(id)}/ranking`} aria-current={active === 'ranking' ? 'page' : undefined}>順位表</AppLink>
    </nav>
  )
}
