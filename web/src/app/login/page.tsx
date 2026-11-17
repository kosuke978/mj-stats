import { CredentialsPage } from '@/components/auth/credentials-page'
export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>
}) {
  return (
    <CredentialsPage mode="login" returnTo={(await searchParams).returnTo} />
  )
}
