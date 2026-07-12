import { z } from 'zod';

import type { Hono } from 'hono';

import type { EngineAuthEnv } from '../auth.js';
import { requireEngineScope } from '../auth.js';
import type { WorkflowRepository } from '../repositories/workflow-repository.js';

const createRunSchema = z.object({
  title: z.string().trim().min(1),
  locale: z.string().trim().min(1),
  brief: z.record(z.unknown()),
}).strict();

export function registerRunRoutes(
  app: Hono,
  dependencies: { repository: WorkflowRepository; env: EngineAuthEnv },
): void {
  app.post('/runs', async (context) => {
    const authFailure = requireEngineScope(context, dependencies.env, 'api');
    if (authFailure) return authFailure;
    const input = createRunSchema.safeParse(await readJson(context.req.raw));
    if (!input.success) return context.json({ error: 'Invalid run input' }, 400);

    const run = await dependencies.repository.bootstrapRun(input.data);
    return context.json(run, 201);
  });

  app.get('/runs/:id', async (context) => {
    const authFailure = requireEngineScope(context, dependencies.env, 'api');
    if (authFailure) return authFailure;

    const run = await dependencies.repository.getRun(context.req.param('id'));
    if (!run) return context.json({ error: 'Run not found' }, 404);
    return context.json(run);
  });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
