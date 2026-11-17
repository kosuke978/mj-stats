import { Skeleton } from "@/components/ui/skeleton"

function MatchCardSkeleton() {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="mb-4 flex items-center gap-2">
        <Skeleton className="h-4 w-4" />
        <Skeleton className="h-4 w-36" />
      </div>

      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="flex items-center justify-between rounded-md border px-3 py-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-14" />
          </div>
        ))}
      </div>
    </div>
  )
}

export default function MatchesLoadingPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-4 py-6">
      <header className="mb-5 space-y-1">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-4 w-64" />
      </header>

      <section className="space-y-4">
        {Array.from({ length: 3 }).map((_, index) => (
          <MatchCardSkeleton key={index} />
        ))}
      </section>
    </main>
  )
}
