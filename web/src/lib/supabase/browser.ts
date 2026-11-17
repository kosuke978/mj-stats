import { createBrowserClient } from '@supabase/ssr'
import { authFetch } from './fetch'

export function browserSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { fetch: authFetch } },
  )
}
