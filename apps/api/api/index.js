import { Hono } from 'hono';
import { handle } from 'hono/vercel';

import { createRuntimeApp } from '../dist/runtime.js';

const app = new Hono();
let runtimeApp;
let runtimeError;

app.get('/health', (context) => context.json({ status: 'ok' }));

app.all('*', async (context) => {
  if (runtimeError) return context.json({ error: 'engine_initialization_failed' }, 500);
  try {
    runtimeApp ??= createRuntimeApp();
    return runtimeApp.fetch(context.req.raw, context.env, context.executionCtx);
  } catch (error) {
    runtimeError = error;
    console.error('engine_initialization_failed', error);
    return context.json({ error: 'engine_initialization_failed' }, 500);
  }
});

export default handle(app);
