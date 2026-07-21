import { pipelineReadModelSchema } from '@knowledge-bits/contracts';

import type { Hono } from 'hono';

import type { EngineAuthConfig } from '../auth.js';
import { requireEngineScope } from '../auth.js';
import type { WorkflowRepository } from '../repositories/workflow-repository.js';
import { PipelineDashboardService } from '../services/pipeline-dashboard.js';

export function registerPipelineRoutes(
  app: Hono,
  dependencies: { repository: WorkflowRepository; auth: EngineAuthConfig },
): void {
  const dashboard = new PipelineDashboardService(dependencies.repository);

  app.get('/pipeline', async (context) => {
    const authFailure = requireEngineScope(context, dependencies.auth, 'review');
    if (authFailure) return authFailure;
    return context.json(pipelineReadModelSchema.parse(await dashboard.load()));
  });
}
