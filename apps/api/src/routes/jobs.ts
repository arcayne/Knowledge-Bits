import {
  bindNotebookRequestSchema,
  claimJobRequestSchema,
  reportJobResultRequestSchema,
} from '@knowledge-bits/contracts';
import { nextTransition, WorkflowTransitionError } from '@knowledge-bits/pipeline';
import { z } from 'zod';

import type { Hono } from 'hono';

import type { EngineAuthConfig } from '../auth.js';
import { requireWorkerPrincipal } from '../auth.js';
import {
  type WorkflowJobContext,
  WorkflowConflictError,
  WorkflowValidationError,
  type WorkflowRepository,
} from '../repositories/workflow-repository.js';
import {
  ArtifactStorageObjectNotFoundError,
  ArtifactStorageOperationError,
  readArtifactStorageObject,
  type ArtifactStorageAdapter,
} from '../services/artifacts.js';

export function registerJobRoutes(
  app: Hono,
  dependencies: { repository: WorkflowRepository; auth: EngineAuthConfig; artifactStorage: ArtifactStorageAdapter },
): void {
  app.post('/jobs/claim', async (context) => {
    const principal = requireWorkerPrincipal(context, dependencies.auth);
    if (principal instanceof Response) return principal;
    const input = claimJobRequestSchema.safeParse(await readJson(context.req.raw));
    if (!input.success) return context.json({ error: 'Invalid job claim input' }, 400);

    const claim = await dependencies.repository.claimJob({
      workerId: principal.workerId,
      capabilities: principal.capabilities,
      leaseSeconds: input.data.leaseSeconds,
      preferredRunId: input.data.preferredRunId,
    });
    if (!claim) return new Response(null, { status: 204 });
    return context.json(claim);
  });

  app.post('/jobs/:id/heartbeat', async (context) => {
    const principal = requireWorkerPrincipal(context, dependencies.auth);
    if (principal instanceof Response) return principal;
    try {
      await dependencies.repository.renewJobLease({
        jobId: context.req.param('id'),
        workerId: principal.workerId,
      });
      return new Response(null, { status: 204 });
    } catch (error) {
      if (error instanceof WorkflowConflictError) {
        return context.json({ error: error.message }, 409);
      }
      throw error;
    }
  });

  app.get('/jobs/:id/artifacts/:artifactId', async (context) => {
    const principal = requireWorkerPrincipal(context, dependencies.auth);
    if (principal instanceof Response) return principal;
    const job = await dependencies.repository.getJobContext(context.req.param('id'));
    if (!job) return context.json({ error: 'Job not found' }, 404);
    const active = await dependencies.repository.hasActiveJobLease({
      jobId: job.job.id,
      runId: job.run.id,
      workerId: principal.workerId,
    });
    const declared = Array.isArray(job.job.input.dependencies)
      && job.job.input.dependencies.some((value) => (
        isRecord(value)
        && value.artifactId === context.req.param('artifactId')
        && typeof value.checksum === 'string'
      ));
    if (!active || !declared) {
      return context.json({ error: 'Artifact is not declared for the active job lease' }, 409);
    }
    const artifact = await dependencies.repository.getArtifact(job.run.id, context.req.param('artifactId'));
    if (!artifact) return context.json({ error: 'Artifact not found' }, 404);
    try {
      const body = await readArtifactStorageObject(dependencies.artifactStorage, artifact.storageKey);
      return new Response(Buffer.from(body), {
        headers: { 'Content-Type': artifact.mediaType, 'Cache-Control': 'private, no-store' },
      });
    } catch (error) {
      if (error instanceof ArtifactStorageObjectNotFoundError) return context.json({ error: error.message }, 404);
      if (error instanceof ArtifactStorageOperationError) return context.json({ error: error.message }, 503);
      throw error;
    }
  });

  app.post('/jobs/:id/notebook', async (context) => {
    const principal = requireWorkerPrincipal(context, dependencies.auth);
    if (principal instanceof Response) return principal;
    const input = bindNotebookRequestSchema.safeParse(await readJson(context.req.raw));
    if (!input.success) return context.json({ error: 'Invalid notebook binding input' }, 400);
    try {
      await dependencies.repository.bindNotebook({
        jobId: context.req.param('id'),
        workerId: principal.workerId,
        notebookLmNotebookId: input.data.notebookLmNotebookId,
      });
      return new Response(null, { status: 204 });
    } catch (error) {
      if (error instanceof WorkflowConflictError) return context.json({ error: error.message }, 409);
      if (error instanceof WorkflowValidationError) return context.json({ error: error.message }, 400);
      throw error;
    }
  });

  app.post('/jobs/:id/result', async (context) => {
    const principal = requireWorkerPrincipal(context, dependencies.auth);
    if (principal instanceof Response) return principal;
    const input = reportJobResultRequestSchema.safeParse(await readJson(context.req.raw));
    if (!input.success || input.data.result.jobId !== context.req.param('id')) {
      return context.json({ error: 'Invalid job result input' }, 400);
    }
    const jobContext = await dependencies.repository.getJobContext(input.data.result.jobId);
    if (!jobContext) return context.json({ error: 'Job not found' }, 404);
    if (jobContext.job.runId !== input.data.result.packageId || jobContext.job.stage !== input.data.result.stage) {
      return context.json({ error: 'Job result does not match the leased job' }, 400);
    }
    try {
      const run = await dependencies.repository.applyJobResult({
        workerId: principal.workerId,
        result: input.data.result,
        transition: jobContext.job.completionReceipt ? undefined : transitionForResult(jobContext, input.data.result),
        retryAt: input.data.retryAt ? new Date(input.data.retryAt) : undefined,
      });
      return context.json(run);
    } catch (error) {
      if (error instanceof WorkflowConflictError) {
        return context.json({ error: error.message }, 409);
      }
      if (error instanceof WorkflowValidationError) {
        return context.json({ error: error.message }, 400);
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
  result: z.infer<typeof reportJobResultRequestSchema>['result'],
) {
  const snapshot = {
    stage: context.stage.name,
    state: context.stage.state,
    revisionAttempts: context.stage.revisionAttempts,
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
      if (!result.error || !result.needsHumanKind) {
        throw new ResultMappingError('Human intervention results require a reason and kind');
      }
      return result.needsHumanKind === 'quality' && context.stage.name === 'check'
        ? nextTransition(snapshot, { type: 'quality_failed', reason: result.error })
        : nextTransition(snapshot, { type: 'job_needs_human', reason: result.error });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
