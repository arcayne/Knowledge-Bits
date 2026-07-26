import { forwardReviewRequest, runtimeEnvironment } from '../../review-proxy.mjs';
import {
  csrfCookieFromRequest,
  operatorErrorResponse,
  validateReviewMutation,
} from '../../operator-auth.mjs';

export async function POST({ request, locals }: { request: Request; locals: App.Locals }): Promise<Response> {
  try {
    validateReviewMutation(request, {
      expectedOrigin: runtimeEnvironment(import.meta.env, 'REVIEW_PUBLIC_ORIGIN'),
      cookieToken: csrfCookieFromRequest(request),
    });
  } catch (error) {
    return operatorErrorResponse(error);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid Nuglet request' }, { status: 400 });
  }
  if (!isRecord(body)) return Response.json({ error: 'Invalid Nuglet request' }, { status: 400 });

  return forwardReviewRequest({
    apiUrl: runtimeEnvironment(import.meta.env, 'ENGINE_API_URL'),
    token: runtimeEnvironment(import.meta.env, 'ENGINE_REVIEW_TOKEN'),
    reviewerId: reviewerId(locals),
    path: '/runs',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
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
