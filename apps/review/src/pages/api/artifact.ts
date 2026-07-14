import { runtimeEnvironment } from '../../review-proxy.mjs';

export async function GET({ url, locals }: { url: URL; locals: App.Locals }): Promise<Response> {
  const runId = url.searchParams.get('runId');
  const artifactId = url.searchParams.get('artifactId');
  if (!isUuid(runId) || !isUuid(artifactId)) {
    return Response.json({ error: 'Valid run and artifact ids are required' }, { status: 400 });
  }

  const apiUrl = runtimeEnvironment(import.meta.env, 'ENGINE_API_URL');
  const token = runtimeEnvironment(import.meta.env, 'ENGINE_REVIEW_TOKEN');
  const reviewerId = (locals as { reviewerId?: string }).reviewerId;
  if (!apiUrl || !token || !reviewerId) {
    return Response.json({ error: 'The review service is not configured' }, { status: 503 });
  }

  try {
    const response = await fetch(new URL(`/runs/${runId}/artifacts/${artifactId}`, apiUrl), {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Knowledge-Bits-Reviewer': reviewerId,
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

function isUuid(value: string | null): value is string {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}
