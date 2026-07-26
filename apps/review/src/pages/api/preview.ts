import { forwardReviewRequest, runtimeEnvironment } from '../../review-proxy.mjs';

export async function GET({ url, locals }: { url: URL; locals: App.Locals }): Promise<Response> {
  const runId = url.searchParams.get('runId');
  if (!isUuid(runId)) {
    return Response.json({ error: 'A valid run id is required' }, { status: 400 });
  }
  return forwardReviewRequest({
    apiUrl: runtimeEnvironment(import.meta.env, 'ENGINE_API_URL'),
    token: runtimeEnvironment(import.meta.env, 'ENGINE_REVIEW_TOKEN'),
    reviewerId: (locals as { reviewerId?: string }).reviewerId ?? '',
    path: `/runs/${encodeURIComponent(runId)}/preview`,
  });
}

function isUuid(value: string | null): value is string {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}
