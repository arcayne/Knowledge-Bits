import { resolveEngineUrl } from './review-proxy.mjs';

export async function forwardArtifactRequest({
  apiUrl,
  token,
  reviewerId,
  runId,
  artifactId,
  fetch = globalThis.fetch,
}) {
  const baseUrl = apiUrl?.trim();
  const reviewToken = token?.trim();
  const principal = reviewerId?.trim();
  if (!baseUrl || !reviewToken || !principal) {
    return Response.json({ error: 'The review service is not configured' }, { status: 503 });
  }

  try {
    const response = await fetch(resolveEngineUrl(
      baseUrl,
      `/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
    ), {
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${reviewToken}`,
        'X-Knowledge-Bits-Reviewer': principal,
      },
    });
    return new Response(response.body, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') ?? 'application/octet-stream',
        'Cache-Control': 'private, no-store',
      },
    });
  } catch {
    return Response.json({ error: 'The artifact service is unavailable' }, { status: 503 });
  }
}
