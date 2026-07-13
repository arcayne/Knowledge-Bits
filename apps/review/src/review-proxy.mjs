export async function forwardReviewRequest({ apiUrl, token, reviewerId, path, init = {}, fetch = globalThis.fetch }) {
  const baseUrl = apiUrl?.trim();
  const reviewToken = token?.trim();
  const principal = reviewerId?.trim();
  if (!baseUrl || !reviewToken || !principal) {
    return Response.json({ error: 'The review service is not configured' }, { status: 503 });
  }

  try {
    const timeout = AbortSignal.timeout(15_000);
    const callerSignal = init.signal instanceof AbortSignal ? init.signal : undefined;
    const response = await fetch(new URL(path, baseUrl), {
      ...init,
      signal: callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${reviewToken}`,
        'X-Knowledge-Bits-Reviewer': principal,
      },
    });
    return new Response(await response.text(), {
      status: response.status,
      headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'application/json' },
    });
  } catch {
    return Response.json({ error: 'The review service is unavailable' }, { status: 503 });
  }
}
