import { jobResultSchema } from '@knowledge-bits/contracts';
import { nextTransition, WorkflowTransitionError } from '@knowledge-bits/pipeline';
import { z } from 'zod';

import type { Hono } from 'hono';

import type { EngineAuthEnv } from '../auth.js';
import { requireEngineScope } from '../auth.js';
import {
  type WorkflowJobContext,
  WorkflowConflictError,
  type WorkflowRepository,
} from '../repositories/workflow-repository.js';

const claimJobSchema = z.object({
  workerId: z.string().trim().min(1),
  capabilities: z.array(z.string().trim().min(1)).min(1),
  leaseSeconds: z.number().int().positive(),
}).strict();

const reportResultSchema = z.object({
  workerId: z.string().trim().min(1),
  result: jobResultSchema,
  retryAt: z.string().datetime().optional(),
}).strict().superRefine((input, refinement) => {
  if (input.result.state === 'waiting' && !input.retryAt) {
    refinement.addIssue({ code: z.ZodIssueCode.custom, message: 'Waiting results require retryAt' });
  }
  if (input.result.state !== 'waiting' && input.retryAt) {
    refinement.addIssue({ code: z.ZodIssueCode.custom, message: 'Only waiting results may include retryAt' });
  }
});

export function registerJobRoutes(
  app: Hono,
  dependencies: { repository: WorkflowRepository; env: EngineAuthEnv },
): void {
  app.post('/jobs/claim', async (context) => {
    const authFailure = requireEngineScope(context, dependencies.env, 'worker');
    if (authFailure) return authFailure;
    const input = claimJobSchema.safeParse(await readJson(context.req.raw));
    if (!input.success) return context.json({ error: 'Invalid job claim input' }, 400);

    const claim = await dependencies.repository.claimJob(input.data);
    if (!claim) return new Response(null, { status: 204 });
    return context.json(claim);
  });

  app.post('/jobs/:id/result', async (context) => {
    const authFailure = requireEngineScope(context, dependencies.env, 'worker');
    if (authFailure) return authFailure;
    const input = reportResultSchema.safeParse(await readJson(context.req.raw));
    if (!input.success || input.data.result.jobId !== context.req.param('id')) {
      return context.json({ error: 'Invalid job result input' }, 400);
    }

    const jobContext = await dependencies.repository.getJobContext(input.data.result.jobId);
    if (!jobContext) return context.json({ error: 'Job not found' }, 404);
    if (jobContext.job.runId !== input.data.result.packageId || jobContext.job.stage !== input.data.result.stage) {
      return context.json({ error: 'Job result does not match the leased job' }, 400);
    }

    try {
      const transition = transitionForResult(jobContext, input.data.result);
      const run = await dependencies.repository.applyJobResult({
        workerId: input.data.workerId,
        result: input.data.result,
        transition,
        retryAt: input.data.retryAt ? new Date(input.data.retryAt) : undefined,
      });
      return context.json(run);
    } catch (error) {
      if (error instanceof WorkflowConflictError) {
        return context.json({ error: error.message }, 409);
      }
      if (error instanceof WorkflowTransitionError || error instanceof ResultMappingError) {
        return context.json({ error: error.message }, 422);
      }
      throw error;
    }
  });
}

function transitionForResult(
  context: WorkflowJobContext,
  result: z.infer<typeof jobResultSchema>,
) {
  const snapshot = {
    stage: context.stage.name,
    state: context.stage.state,
    revisionAttempts: context.stage.attempt,
    packageChecksum: context.packageChecksum,
    approvedChecksum: context.approvedChecksum,
    reason: context.stage.reason ?? undefined,
  };
  switch (result.state) {
    case 'done':
      if (!result.outputChecksum) throw new ResultMappingError('Completed results require an output checksum');
      return nextTransition(snapshot, { type: 'stage_completed', packageChecksum: result.outputChecksum });
    case 'waiting':
      if (!result.error) throw new ResultMappingError('Waiting results require a reason');
      return nextTransition(snapshot, { type: 'job_waiting', reason: result.error });
    case 'needs_human':
      if (context.stage.name !== 'check' || !result.error) {
        throw new ResultMappingError('Only check results may require human intervention');
      }
      return nextTransition(snapshot, { type: 'quality_failed', reason: result.error });
    default:
      throw new ResultMappingError(`Workers cannot report ${result.state} as a result`);
  }
}

class ResultMappingError extends Error {}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
