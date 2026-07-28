import { forwardReviewRequest, runtimeEnvironment } from '../../review-proxy.mjs';
import {
  csrfCookieFromRequest,
  operatorErrorResponse,
  validateReviewMutation,
} from '../../operator-auth.mjs';

const BRANDED_INFOGRAPHIC_RECIPE = {
  id: 'nuglet.visual.infographic',
  version: '2.0.0',
  checksum: 'sha256:f48e77547bf0d1b1890bc4118902fbcae185d6b55ec21c929410adab02677206',
} as const;

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
    return Response.json({ error: 'Invalid infographic regeneration input' }, { status: 400 });
  }
  if (!isRecord(body) || typeof body.runId !== 'string' || !body.runId.trim()) {
    return Response.json({ error: 'A run id is required' }, { status: 400 });
  }
  const runId = body.runId.trim();
  return forwardReviewRequest({
    apiUrl: runtimeEnvironment(import.meta.env, 'ENGINE_API_URL'),
    token: runtimeEnvironment(import.meta.env, 'ENGINE_REVIEW_TOKEN'),
    reviewerId: reviewerId(locals),
    path: `/runs/${encodeURIComponent(runId)}/regenerate-media`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kinds: ['infographic'],
        recipeOverrides: { infographic: BRANDED_INFOGRAPHIC_RECIPE },
      }),
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
