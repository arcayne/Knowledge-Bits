import { serve } from '@hono/node-server';

import { createRuntimeApp } from './runtime.js';

const app = createRuntimeApp();
const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port });
