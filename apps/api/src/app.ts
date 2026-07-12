import { Hono } from 'hono';

import { createEngineAuthConfig, type EngineAuthEnv } from './auth.js';
import { registerArtifactRoutes } from './routes/artifacts.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerReviewRoutes } from './routes/reviews.js';
import type { WorkflowRepository } from './repositories/workflow-repository.js';
import { type ArtifactStorageAdapter, UnavailableArtifactStorageAdapter } from './services/artifacts.js';

export interface CreateAppOptions {
  repository: WorkflowRepository;
  artifactStorage?: ArtifactStorageAdapter;
  env?: EngineAuthEnv;
}

export function createApp(options: CreateAppOptions): Hono {
  const app = new Hono();
  const dependencies = {
    repository: options.repository,
    auth: createEngineAuthConfig(options.env ?? (process.env as EngineAuthEnv)),
  };
  const artifactStorage = options.artifactStorage ?? new UnavailableArtifactStorageAdapter();
  registerRunRoutes(app, dependencies);
  registerReviewRoutes(app, { ...dependencies, artifactStorage });
  registerJobRoutes(app, dependencies);
  registerArtifactRoutes(app, {
    ...dependencies,
    artifactStorage,
  });
  return app;
}
