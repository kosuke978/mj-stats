import { CredentialsPage } from '@/components/auth/credentials-page'
export default async function Signup({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>
}) {
  return (
    <CredentialsPage mode="signup" returnTo={(await searchParams).returnTo} />
  )
}
