import {
  artifactCompleteRequestSchema,
  artifactPrepareRequestSchema,
  artifactPrepareResponseSchema,
} from '@knowledge-bits/contracts';

import type { Context, Hono } from 'hono';

import type { EngineAuthConfig } from '../auth.js';
import { requireWorkerPrincipal } from '../auth.js';
import {
  ArtifactLeaseError,
  ArtifactMetadataMismatchError,
  ArtifactService,
  ArtifactStorageObjectExistsError,
  ArtifactStorageObjectNotFoundError,
  ArtifactStorageOperationError,
  ArtifactStorageUnavailableError,
  ArtifactUploadCapabilityError,
  ArtifactUploadMediaTypeMismatchError,
  LocalFilesystemArtifactStorageAdapter,
  type ArtifactStorageAdapter,
} from '../services/artifacts.js';
import { WorkflowConflictError, type WorkflowRepository } from '../repositories/workflow-repository.js';

export function registerArtifactRoutes(
  app: Hono,
  dependencies: { repository: WorkflowRepository; auth: EngineAuthConfig; artifactStorage: ArtifactStorageAdapter },
): void {
  const service = new ArtifactService({
    repository: dependencies.repository,
    storage: dependencies.artifactStorage,
  });

  const localStorage = dependencies.artifactStorage instanceof LocalFilesystemArtifactStorageAdapter
    ? dependencies.artifactStorage
    : undefined;
  if (localStorage) {
    app.put('/artifacts/upload/:token', async (context) => {
      const mediaType = context.req.header('content-type');
      if (!mediaType) return context.json({ error: 'Artifact upload requires a content type' }, 400);
      try {
        await localStorage.upload(
          context.req.param('token'),
          new Uint8Array(await context.req.raw.arrayBuffer()),
          mediaType,
        );
        return context.body(null, 204);
      } catch (error) {
        if (error instanceof ArtifactUploadCapabilityError) return context.json({ error: error.message }, 404);
        if (error instanceof ArtifactUploadMediaTypeMismatchError) return context.json({ error: error.message }, 422);
        if (error instanceof ArtifactStorageObjectExistsError) return context.json({ error: error.message }, 409);
        if (error instanceof ArtifactStorageOperationError) return context.json({ error: error.message }, 503);
        throw error;
      }
    });
  }

  app.post('/artifacts/prepare', async (context) => {
    const principal = requireWorkerPrincipal(context, dependencies.auth);
    if (principal instanceof Response) return principal;
    const input = artifactPrepareRequestSchema.safeParse(await readJson(context.req.raw));
    if (!input.success) return context.json({ error: 'Invalid artifact preparation input' }, 400);

    try {
      const prepared = await service.prepare(principal.workerId, input.data);
      return context.json(artifactPrepareResponseSchema.parse(prepared), 201);
    } catch (error) {
      return artifactErrorResponse(context, error);
    }
  });

  app.post('/artifacts/complete', async (context) => {
    const principal = requireWorkerPrincipal(context, dependencies.auth);
    if (principal instanceof Response) return principal;
    const input = artifactCompleteRequestSchema.safeParse(await readJson(context.req.raw));
    if (!input.success) {
      return context.json({ error: 'Invalid artifact completion input' }, 400);
    }

    try {
      const artifact = await service.complete(principal.workerId, input.data);
      return context.json(artifact, 201);
    } catch (error) {
      return artifactErrorResponse(context, error);
    }
  });
}

function artifactErrorResponse(context: Context, error: unknown) {
  if (error instanceof ArtifactLeaseError || error instanceof WorkflowConflictError) {
    return context.json({ error: error.message }, 409);
  }
  if (error instanceof ArtifactMetadataMismatchError) {
    return context.json({ error: error.message }, 422);
  }
  if (error instanceof ArtifactStorageObjectNotFoundError) {
    return context.json({ error: error.message }, 404);
  }
  if (error instanceof ArtifactStorageOperationError || error instanceof ArtifactStorageUnavailableError) {
    return context.json({ error: error.message }, 503);
  }
  throw error;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
