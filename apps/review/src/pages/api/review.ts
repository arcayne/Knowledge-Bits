import { forwardReviewRequest } from '../../review-proxy.mjs';
import {
  csrfCookieFromRequest,
  operatorErrorResponse,
  validateReviewMutation,
} from '../../operator-auth.mjs';

export async function GET({ url, locals }: { url: URL; locals: App.Locals }): Promise<Response> {
  const runId = url.searchParams.get('runId');
  if (!runId) return Response.json({ error: 'A run id is required' }, { status: 400 });
  return forward(`/runs/${encodeURIComponent(runId)}/review`, reviewerId(locals));
}

export async function POST({ request, locals }: { request: Request; locals: App.Locals }): Promise<Response> {
  try {
    validateReviewMutation(request, {
      expectedOrigin: import.meta.env.REVIEW_PUBLIC_ORIGIN,
      cookieToken: csrfCookieFromRequest(request),
    });
  } catch (error) {
    return operatorErrorResponse(error);
  }
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
  return forward(`/runs/${encodeURIComponent(runId)}/review`, reviewerId(locals), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision, packageChecksum, ...(typeof comment === 'string' ? { comment } : {}) }),
  });
}

async function forward(path: string, reviewerId: string, init: RequestInit = {}): Promise<Response> {
  return forwardReviewRequest({
    apiUrl: import.meta.env.ENGINE_API_URL,
    token: import.meta.env.ENGINE_REVIEW_TOKEN,
    reviewerId,
    path,
    init,
  });
}

function reviewerId(locals: App.Locals): string {
  const value = (locals as { reviewerId?: string }).reviewerId;
  if (!value) throw new Error('Authenticated reviewer identity is missing');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
