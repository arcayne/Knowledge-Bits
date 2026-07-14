import type { EngineAuthEnv } from './auth.js';
import { createApp } from './app.js';
import { createIsolatedPrismaClient } from './config.js';
import { createWorkflowRepository } from './repositories/workflow-repository.js';
import { createHttpDeliveryAdapterFromEnv } from './services/delivery-adapters/http.js';
import { createArtifactStorageFromEnv } from './services/r2-artifacts.js';

export function createRuntimeApp(env: NodeJS.ProcessEnv = process.env) {
  const prisma = createIsolatedPrismaClient(env);
  return createApp({
    repository: createWorkflowRepository(prisma),
    deliveryAdapter: createHttpDeliveryAdapterFromEnv(env),
    artifactStorage: createArtifactStorageFromEnv(env),
    env: env as EngineAuthEnv,
  });
}
