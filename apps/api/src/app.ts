import { Hono } from 'hono';

import { createEngineAuthConfig, type EngineAuthEnv } from './auth.js';
import { registerArtifactRoutes } from './routes/artifacts.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerReviewRoutes } from './routes/reviews.js';
import { registerDeliveryRoutes } from './routes/deliveries.js';
import type { WorkflowRepository } from './repositories/workflow-repository.js';
import { type ArtifactStorageAdapter, UnavailableArtifactStorageAdapter } from './services/artifacts.js';
import { DeliveryService } from './services/delivery.js';
import type { DeliveryAdapter } from './services/delivery-adapters/types.js';

export interface CreateAppOptions {
  repository: WorkflowRepository;
  artifactStorage?: ArtifactStorageAdapter;
  deliveryAdapter?: DeliveryAdapter;
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
  registerJobRoutes(app, { ...dependencies, artifactStorage });
  registerArtifactRoutes(app, {
    ...dependencies,
    artifactStorage,
  });
  if (options.deliveryAdapter) {
    registerDeliveryRoutes(app, {
      ...dependencies,
      deliveryService: new DeliveryService({ repository: options.repository, adapter: options.deliveryAdapter }),
    });
  }
  return app;
}
