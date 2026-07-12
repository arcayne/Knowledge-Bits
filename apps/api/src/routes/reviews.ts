import {
  reviewRunRequestSchema,
  reviewRunResponseSchema,
} from '@knowledge-bits/contracts';

import type { Hono } from 'hono';

import type { EngineAuthConfig } from '../auth.js';
import { requireEngineScope } from '../auth.js';
import {
  WorkflowConflictError,
  WorkflowNotFoundError,
  WorkflowValidationError,
  type WorkflowRepository,
  type WorkflowRun,
} from '../repositories/workflow-repository.js';

export function registerReviewRoutes(
  app: Hono,
  dependencies: { repository: WorkflowRepository; auth: EngineAuthConfig },
): void {
  app.get('/runs/:id/review', async (context) => {
    const authFailure = requireEngineScope(context, dependencies.auth, 'review');
    if (authFailure) return authFailure;

    const run = await dependencies.repository.getRun(context.req.param('id'));
    if (!run) return context.json({ error: 'Run not found' }, 404);
    return context.json({ run: toRunResponse(run) });
  });

  app.post('/runs/:id/review', async (context) => {
    const authFailure = requireEngineScope(context, dependencies.auth, 'review');
    if (authFailure) return authFailure;
    const input = reviewRunRequestSchema.safeParse(await readJson(context.req.raw));
    if (!input.success) return context.json({ error: 'Invalid review input' }, 400);

    try {
      const run = await dependencies.repository.reviewRun({
        runId: context.req.param('id'),
        ...input.data,
      });
      const stage = run.stages[run.currentStage];
      if (!stage || !run.packageChecksum) throw new WorkflowConflictError('Review state is incomplete');
      return context.json(reviewRunResponseSchema.parse({
        runId: run.id,
        currentStage: run.currentStage,
        state: stage.state,
        currentRevision: run.currentRevision,
        reviewStatus: run.reviewStatus,
        packageChecksum: run.packageChecksum,
        approvedChecksum: run.approvedChecksum,
      }));
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) return context.json({ error: error.message }, 404);
      if (error instanceof WorkflowConflictError) return context.json({ error: error.message }, 409);
      if (error instanceof WorkflowValidationError) return context.json({ error: error.message }, 400);
      throw error;
    }
  });
}

function toRunResponse(run: WorkflowRun) {
  return {
    ...run,
    nextRetryAt: run.nextRetryAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
