import { Hono } from 'hono';

import { createEngineAuthConfig, type EngineAuthEnv } from './auth.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerRunRoutes } from './routes/runs.js';
import type { WorkflowRepository } from './repositories/workflow-repository.js';

export interface CreateAppOptions {
  repository: WorkflowRepository;
  env?: EngineAuthEnv;
}

export function createApp(options: CreateAppOptions): Hono {
  const app = new Hono();
  const dependencies = {
    repository: options.repository,
    auth: createEngineAuthConfig(options.env ?? (process.env as EngineAuthEnv)),
  };
  registerRunRoutes(app, dependencies);
  registerJobRoutes(app, dependencies);
  return app;
}
