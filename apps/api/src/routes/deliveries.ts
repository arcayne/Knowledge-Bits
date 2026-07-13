import { nextTransition } from '@knowledge-bits/pipeline';
import { z } from 'zod';

import type { Hono } from 'hono';

import {
  requireEngineScope,
  requireWorkerPrincipal,
  type EngineAuthConfig,
} from '../auth.js';
import {
  WorkflowConflictError,
  WorkflowNotFoundError,
  type WorkflowRepository,
} from '../repositories/workflow-repository.js';
import {
  DeliveryConflictError,
  DeliveryNotFoundError,
  DeliveryService,
} from '../services/delivery.js';

const runDeliverySchema = z.object({ jobId: z.string().uuid() }).strict();

export function registerDeliveryRoutes(
  app: Hono,
  dependencies: {
    repository: WorkflowRepository;
    auth: EngineAuthConfig;
    deliveryService: DeliveryService;
  },
): void {
  app.post('/deliveries/:id/run', async (context) => {
    const principal = requireWorkerPrincipal(context, dependencies.auth);
    if (principal instanceof Response) return principal;
    if (!principal.capabilities.includes('deliver_package')) {
      return context.json({ error: 'Worker cannot execute delivery' }, 403);
    }
    const input = runDeliverySchema.safeParse(await readJson(context.req.raw));
    if (!input.success) return context.json({ error: 'Invalid delivery execution input' }, 400);
    const jobContext = await dependencies.repository.getJobContext(input.data.jobId);
    if (!jobContext) return context.json({ error: 'Delivery job not found' }, 404);
    const delivery = await dependencies.repository.getDelivery(context.req.param('id'));
    if (!delivery) return context.json({ error: 'Delivery not found' }, 404);
    if (jobContext.job.stage !== 'deliver'
      || jobContext.job.input.deliveryId !== delivery.id
      || jobContext.job.input.packageVersionId !== delivery.packageVersionId
      || jobContext.job.input.packageChecksum !== delivery.packageChecksum
      || !await dependencies.repository.hasActiveJobLease({
        jobId: jobContext.job.id,
        runId: delivery.runId,
        workerId: principal.workerId,
      })) {
      return context.json({ error: 'Delivery job lease or immutable package identity does not match' }, 409);
    }

    try {
      const result = await dependencies.deliveryService.run(delivery.id);
      const snapshot = {
        stage: jobContext.stage.name,
        state: jobContext.stage.state,
        revisionAttempts: jobContext.stage.revisionAttempts,
        packageChecksum: jobContext.packageChecksum,
        approvedChecksum: jobContext.approvedChecksum,
        reason: jobContext.stage.reason ?? undefined,
      };
      const completedAt = new Date().toISOString();
      const transition = result.state === 'succeeded'
        ? nextTransition(snapshot, { type: 'delivery_succeeded' })
        : result.state === 'needs_human'
          ? nextTransition(snapshot, { type: 'delivery_needs_human', reason: result.error })
          : nextTransition(snapshot, { type: 'job_waiting', reason: result.error });
      await dependencies.repository.applyJobResult({
        workerId: principal.workerId,
        result: {
          jobId: jobContext.job.id,
          packageId: delivery.runId,
          stage: 'deliver',
          state: result.state === 'succeeded' ? 'done' : result.state === 'needs_human' ? 'needs_human' : 'waiting',
          completedAt,
          outputChecksum: result.state === 'succeeded' ? result.packageChecksum : null,
          error: result.state === 'succeeded' ? null : result.error,
        },
        transition,
        ...('retryAt' in result ? { retryAt: result.retryAt } : {}),
      });
      return context.json(result, result.state === 'succeeded' ? 200 : 202);
    } catch (error) {
      if (error instanceof DeliveryNotFoundError || error instanceof WorkflowNotFoundError) {
        return context.json({ error: error.message }, 404);
      }
      if (error instanceof DeliveryConflictError || error instanceof WorkflowConflictError) {
        return context.json({ error: error.message }, 409);
      }
      throw error;
    }
  });

  app.post('/deliveries/:id/retry', async (context) => {
    const authFailure = requireEngineScope(context, dependencies.auth, 'review');
    if (authFailure) return authFailure;
    try {
      const result = await dependencies.repository.retryDelivery(context.req.param('id'));
      return context.json({ deliveryId: result.delivery.id, nextAttempt: result.nextAttempt });
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) return context.json({ error: error.message }, 404);
      if (error instanceof WorkflowConflictError) return context.json({ error: error.message }, 409);
      throw error;
    }
  });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
