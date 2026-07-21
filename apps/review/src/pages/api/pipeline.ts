import { forwardReviewRequest, runtimeEnvironment } from '../../review-proxy.mjs';

export async function GET({ locals }: { locals: App.Locals }): Promise<Response> {
  return forwardReviewRequest({
    apiUrl: runtimeEnvironment(import.meta.env, 'ENGINE_API_URL'),
    token: runtimeEnvironment(import.meta.env, 'ENGINE_REVIEW_TOKEN'),
    reviewerId: (locals as { reviewerId?: string }).reviewerId ?? '',
    path: '/pipeline',
  });
}
