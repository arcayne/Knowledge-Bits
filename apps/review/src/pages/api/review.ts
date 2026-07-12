export async function GET({ url }: { url: URL }): Promise<Response> {
  const runId = url.searchParams.get('runId');
  if (!runId) return Response.json({ error: 'A run id is required' }, { status: 400 });
  return forward(`/runs/${encodeURIComponent(runId)}/review`);
}

export async function POST({ request }: { request: Request }): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid review input' }, { status: 400 });
  }
  if (!isRecord(body) || typeof body.runId !== 'string' || !body.runId) {
    return Response.json({ error: 'A run id is required' }, { status: 400 });
  }
  const reviewerId = import.meta.env.ENGINE_REVIEWER_ID?.trim();
  if (!reviewerId) {
    return Response.json({ error: 'The review identity is not configured' }, { status: 503 });
  }
  const { runId, reviewerId: _untrustedReviewerId, ...decision } = body;
  return forward(`/runs/${encodeURIComponent(runId)}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...decision, reviewerId }),
  });
}

async function forward(path: string, init: RequestInit = {}): Promise<Response> {
  const apiUrl = import.meta.env.ENGINE_API_URL?.trim();
  const token = import.meta.env.ENGINE_REVIEW_TOKEN?.trim();
  if (!apiUrl || !token) {
    return Response.json({ error: 'The review service is not configured' }, { status: 503 });
  }

  try {
    const response = await fetch(new URL(path, apiUrl), {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...init.headers,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
