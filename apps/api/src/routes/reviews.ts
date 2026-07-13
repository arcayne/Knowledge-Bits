import {
  reviewRunRequestSchema,
  reviewRunResponseSchema,
} from '@knowledge-bits/contracts';

import type { Hono } from 'hono';

import type { EngineAuthConfig } from '../auth.js';
import { requireEngineScope, requireReviewPrincipal } from '../auth.js';
import {
  WorkflowConflictError,
  WorkflowNotFoundError,
  WorkflowValidationError,
  type WorkflowRepository,
} from '../repositories/workflow-repository.js';
import {
  ArtifactStorageObjectNotFoundError,
  ArtifactStorageOperationError,
  type ArtifactStorageAdapter,
} from '../services/artifacts.js';
import {
  ReviewPackageNotFoundError,
  ReviewPackageService,
} from '../services/review-packages.js';

export function registerReviewRoutes(
  app: Hono,
  dependencies: { repository: WorkflowRepository; auth: EngineAuthConfig; artifactStorage: ArtifactStorageAdapter },
): void {
  const packages = new ReviewPackageService({ repository: dependencies.repository, storage: dependencies.artifactStorage });
  app.get('/runs/:id/review', async (context) => {
    const authFailure = requireEngineScope(context, dependencies.auth, 'review');
    if (authFailure) return authFailure;

    try {
      return context.json(await packages.load(context.req.param('id')));
    } catch (error) {
      if (error instanceof ReviewPackageNotFoundError) return context.json({ error: error.message }, 404);
      throw error;
    }
  });

  app.get('/runs/:id/artifacts/:artifactId', async (context) => {
    const authFailure = requireEngineScope(context, dependencies.auth, 'review');
    if (authFailure) return authFailure;
    try {
      const artifact = await packages.readArtifact(context.req.param('id'), context.req.param('artifactId'));
      return new Response(Buffer.from(artifact.body), {
        headers: {
          'Content-Type': artifact.mediaType,
          'Cache-Control': 'private, no-store',
        },
      });
    } catch (error) {
      if (error instanceof ReviewPackageNotFoundError) return context.json({ error: error.message }, 404);
      if (error instanceof ArtifactStorageObjectNotFoundError) return context.json({ error: error.message }, 404);
      if (error instanceof ArtifactStorageOperationError) return context.json({ error: error.message }, 503);
      throw error;
    }
  });

  app.post('/runs/:id/review', async (context) => {
    const principal = requireReviewPrincipal(context, dependencies.auth);
    if (principal instanceof Response) return principal;
    const input = reviewRunRequestSchema.safeParse(await readJson(context.req.raw));
    if (!input.success) return context.json({ error: 'Invalid review input' }, 400);

    try {
      const current = await dependencies.repository.getRun(context.req.param('id'));
      if (!current) throw new WorkflowNotFoundError('Run not found');
      const existingReview = await dependencies.repository.getReview(current.id, input.data.packageChecksum);
      if (!existingReview && current.currentStage === 'human_review' && current.reviewStatus === 'pending') {
        const reviewModel = await packages.load(current.id);
        if (!reviewModel.decisionAllowed || reviewModel.package?.packageChecksum !== input.data.packageChecksum) {
          throw new WorkflowConflictError('Review requires a complete, readable current package');
        }
      }
      const run = await dependencies.repository.reviewRun({
        runId: context.req.param('id'),
        reviewerId: principal,
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

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
