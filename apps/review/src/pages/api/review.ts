import { forwardReviewRequest } from '../../review-proxy.mjs';

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
  const { runId } = body;
  const decision = body.decision;
  const packageChecksum = body.packageChecksum;
  const comment = body.comment;
  return forward(`/runs/${encodeURIComponent(runId)}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision, packageChecksum, ...(typeof comment === 'string' ? { comment } : {}) }),
  });
}

async function forward(path: string, init: RequestInit = {}): Promise<Response> {
  return forwardReviewRequest({
    apiUrl: import.meta.env.ENGINE_API_URL,
    token: import.meta.env.ENGINE_REVIEW_TOKEN,
    path,
    init,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
