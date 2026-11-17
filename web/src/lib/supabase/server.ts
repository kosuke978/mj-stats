import 'server-only'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { authFetch } from './fetch'

// Per-request client. Proxy writes refreshed cookies before rendering.
export async function serverSupabase(writable = false) {
  const store = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { fetch: authFetch },
      cookies: {
        getAll: () => store.getAll(),
        setAll(values) {
          if (writable)
            values.forEach(({ name, value, options }) =>
              store.set(name, value, options),
            )
        },
      },
    },
  )
}
