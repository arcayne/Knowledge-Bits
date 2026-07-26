import {
  pipelineReadModelSchema,
  progressivePreviewReadModelSchema,
} from '@knowledge-bits/contracts';

import type { Hono } from 'hono';

import type { EngineAuthConfig } from '../auth.js';
import { requireEngineScope } from '../auth.js';
import type { WorkflowRepository } from '../repositories/workflow-repository.js';
import {
  ArtifactStorageObjectNotFoundError,
  ArtifactStorageOperationError,
  type ArtifactStorageAdapter,
} from '../services/artifacts.js';
import {
  ProgressivePreviewNotFoundError,
  ProgressivePreviewService,
} from '../services/progressive-previews.js';

export function registerPipelineRoutes(
  app: Hono,
  dependencies: { repository: WorkflowRepository; auth: EngineAuthConfig; artifactStorage: ArtifactStorageAdapter },
): void {
  const previews = new ProgressivePreviewService({
    repository: dependencies.repository,
    storage: dependencies.artifactStorage,
  });

  app.get('/pipeline', async (context) => {
    const authFailure = requireEngineScope(context, dependencies.auth, 'review');
    if (authFailure) return authFailure;
    return context.json(pipelineReadModelSchema.parse(await previews.list()));
  });

  app.get('/runs/:id/preview', async (context) => {
    const authFailure = requireEngineScope(context, dependencies.auth, 'review');
    if (authFailure) return authFailure;
    try {
      return context.json(progressivePreviewReadModelSchema.parse(await previews.load(context.req.param('id'))));
    } catch (error) {
      if (error instanceof ProgressivePreviewNotFoundError) return context.json({ error: error.message }, 404);
      throw error;
    }
  });

  app.get('/runs/:id/artifacts/:artifactId', async (context) => {
    const authFailure = requireEngineScope(context, dependencies.auth, 'review');
    if (authFailure) return authFailure;
    try {
      const artifact = await previews.readArtifact(context.req.param('id'), context.req.param('artifactId'));
      return new Response(Buffer.from(artifact.body), {
        headers: {
          'Content-Type': artifact.mediaType,
          'Cache-Control': 'private, no-store',
        },
      });
    } catch (error) {
      if (error instanceof ProgressivePreviewNotFoundError) return context.json({ error: error.message }, 404);
      if (error instanceof ArtifactStorageObjectNotFoundError) return context.json({ error: 'Artifact is unavailable' }, 404);
      if (error instanceof ArtifactStorageOperationError) return context.json({ error: 'Artifact storage is unavailable' }, 503);
      throw error;
    }
  });
}
