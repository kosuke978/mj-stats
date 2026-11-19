import type { ComponentProps } from 'react'

export const navLink = 'inline-flex min-h-11 items-center rounded-md px-2 underline underline-offset-4 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2'

export function AppLink(props: ComponentProps<'a'> & { href: string }) {
  // A document navigation rechecks the viewer and membership, including on revisits.
  return <a {...props} />
}
