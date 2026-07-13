export async function forwardReviewRequest({ apiUrl, token, path, init = {}, fetch = globalThis.fetch }) {
  const baseUrl = apiUrl?.trim();
  const reviewToken = token?.trim();
  if (!baseUrl || !reviewToken) {
    return Response.json({ error: 'The review service is not configured' }, { status: 503 });
  }

  try {
    const response = await fetch(new URL(path, baseUrl), {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${reviewToken}`,
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
