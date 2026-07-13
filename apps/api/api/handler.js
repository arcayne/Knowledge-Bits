import { Hono } from 'hono';
import { getRequestListener } from '@hono/node-server';

import { assertEngineIsolation } from '../dist/config.js';
import { createRuntimeApp } from '../dist/runtime.js';

const app = new Hono().basePath('/api');
let runtimeApp;
let runtimeError;

app.get('/health', (context) => context.json({ status: 'ok' }));

app.get('/health/diagnostics', (context) => {
  let databaseUrlParseable = false;
  try {
    if (process.env.ENGINE_DATABASE_URL?.trim()) new URL(process.env.ENGINE_DATABASE_URL);
    databaseUrlParseable = Boolean(process.env.ENGINE_DATABASE_URL?.trim());
  } catch {
    databaseUrlParseable = false;
  }
  let isolation = 'ok';
  try {
    assertEngineIsolation(process.env);
  } catch (error) {
    isolation = error instanceof Error ? error.message : 'failed';
  }
  return context.json({
    engineDatabaseUrlConfigured: Boolean(process.env.ENGINE_DATABASE_URL?.trim()),
    engineDatabaseUrlParseable: databaseUrlParseable,
    migrationDatabaseUrlPresent: Boolean(process.env.ENGINE_MIGRATION_DATABASE_URL?.trim()),
    databaseUrlPresent: Boolean(process.env.DATABASE_URL?.trim()),
    deliveryAdapterConfigured: Boolean(process.env.DELIVERY_ADAPTER_URL?.trim()),
    apiTokenConfigured: Boolean(process.env.ENGINE_API_TOKEN?.trim()),
    reviewTokenConfigured: Boolean(process.env.ENGINE_REVIEW_TOKEN?.trim()),
    workerCredentialsConfigured: Boolean(process.env.ENGINE_WORKER_CREDENTIALS?.trim()),
    isolation,
  }));

app.all('*', async (context) => {
  if (runtimeError) return context.json({ error: 'engine_initialization_failed' }, 500);
  try {
    runtimeApp ??= createRuntimeApp();
    const requestUrl = new URL(context.req.url);
    requestUrl.pathname = requestUrl.pathname.replace(/^\/api(?=\/|$)/, '') || '/';
    const request = new Request(requestUrl, context.req.raw);
    return runtimeApp.fetch(request, context.env, context.executionCtx);
  } catch (error) {
    runtimeError = error;
    console.error('engine_initialization_failed', error);
    return context.json({ error: 'engine_initialization_failed' }, 500);
  }
});

export default getRequestListener(app.fetch);
