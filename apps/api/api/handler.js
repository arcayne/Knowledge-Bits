import { Hono } from 'hono';
import { getRequestListener } from '@hono/node-server';

import { createRuntimeApp } from '../dist/runtime.js';

const app = new Hono().basePath('/api');
let runtimeApp;
let runtimeError;

app.get('/health', (context) => context.json({ status: 'ok' }));

app.all('*', async (context) => {
  if (runtimeError) return context.json({ error: 'engine_initialization_failed' }, 500);
  try {
    runtimeApp ??= createRuntimeApp();
    const requestUrl = new URL(context.req.url);
    requestUrl.pathname = requestUrl.pathname.replace(/^\/api(?=\/|$)/, '') || '/';
    const rawRequest = context.req.raw;
    const body = ['GET', 'HEAD'].includes(rawRequest.method)
      ? undefined
      : await rawRequest.arrayBuffer();
    const request = new Request(requestUrl, {
      method: rawRequest.method,
      headers: rawRequest.headers,
      body,
    });
    return runtimeApp.fetch(request);
  } catch (error) {
    runtimeError = error;
    console.error('engine_initialization_failed', error);
    return context.json({ error: 'engine_initialization_failed' }, 500);
  }
});

export default getRequestListener(app.fetch);
