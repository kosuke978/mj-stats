import { CredentialsPage } from '@/components/auth/credentials-page'
export default async function Reset({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>
}) {
  return (
    <CredentialsPage mode="reset" returnTo={(await searchParams).returnTo} />
  )
}
