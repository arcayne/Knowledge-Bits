import { createRunRequestSchema, workflowRunResponseSchema } from '@knowledge-bits/contracts';

import type { Hono } from 'hono';

import type { EngineAuthConfig } from '../auth.js';
import { requireEngineScope } from '../auth.js';
import { WorkflowConflictError, type WorkflowRepository, type WorkflowRun } from '../repositories/workflow-repository.js';

export function registerRunRoutes(
  app: Hono,
  dependencies: { repository: WorkflowRepository; auth: EngineAuthConfig },
): void {
  app.post('/runs', async (context) => {
    const authFailure = requireEngineScope(context, dependencies.auth, 'api');
    if (authFailure) return authFailure;
    const input = createRunRequestSchema.safeParse(await readJson(context.req.raw));
    if (!input.success) return context.json({ error: 'Invalid run input' }, 400);

    try {
      const run = await dependencies.repository.bootstrapRun({
        ...input.data,
        notebookLmNotebookId: input.data.notebookLmNotebookId
          ?? notebookIdFromBrief(input.data.brief),
      });
      return context.json(workflowRunResponseSchema.parse(toRunResponse(run)), 201);
    } catch (error) {
      if (error instanceof WorkflowConflictError) {
        return context.json({ error: error.message }, 409);
      }
      throw error;
    }
  });

  app.get('/runs/:id', async (context) => {
    const authFailure = requireEngineScope(context, dependencies.auth, 'api');
    if (authFailure) return authFailure;

    const run = await dependencies.repository.getRun(context.req.param('id'));
    if (!run) return context.json({ error: 'Run not found' }, 404);
    return context.json(workflowRunResponseSchema.parse(toRunResponse(run)));
  });
}

function toRunResponse(run: WorkflowRun) {
  return {
    ...run,
    notebookLmNotebookId: run.notebookLmNotebookId ?? null,
    packageChecksum: run.packageChecksum,
    approvedChecksum: run.approvedChecksum,
    reviewStatus: run.reviewStatus,
    nextRetryAt: run.nextRetryAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

function notebookIdFromBrief(brief: Record<string, unknown>): string | undefined {
  const value = brief.notebookLmNotebookId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
