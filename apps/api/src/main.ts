import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { createIsolatedPrismaClient } from './config.js';
import { createWorkflowRepository } from './repositories/workflow-repository.js';

const prisma = createIsolatedPrismaClient();
const app = createApp({ repository: createWorkflowRepository(prisma) });
const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port });
