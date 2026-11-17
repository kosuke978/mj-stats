// Keep temporary Auth/network failures bounded and out of credential-bearing logs.
export async function authFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
) {
  const deadline = AbortSignal.timeout(5_000)
  try {
    return await fetch(input, {
      ...init,
      cache: 'no-store',
      signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
    })
  } catch {
    // The SDK treats 503 as retryable and retains the recoverable session.
    return Response.json(
      { message: 'Authentication service unavailable' },
      { status: 503 },
    )
  }
}
