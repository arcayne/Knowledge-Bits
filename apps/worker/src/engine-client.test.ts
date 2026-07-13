import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { JobClaim } from '@knowledge-bits/contracts';

import { HttpEngineClient } from './engine-client.js';

const job: JobClaim = {
  jobId: randomUUID(),
  packageId: randomUUID(),
  stage: 'research',
  claimedBy: 'fixture-worker',
  claimedAt: '2026-07-12T18:00:00.000Z',
  leaseExpiresAt: '2026-07-12T18:01:00.000Z',
  attempt: 1,
  revision: 1,
};

test('maps a renewed heartbeat response to continue', async () => {
  const client = new HttpEngineClient({
    baseUrl: 'https://engine.example.test',
    workerToken: 'worker-token',
    fetch: async () => new Response(null, { status: 204 }),
  });

  assert.deepEqual(await client.heartbeat(job), { kind: 'continue' });
});

test('maps a heartbeat lease conflict to interrupted', async () => {
  const client = new HttpEngineClient({
    baseUrl: 'https://engine.example.test',
    workerToken: 'worker-token',
    fetch: async () => new Response(JSON.stringify({ error: 'Job lease is no longer valid' }), { status: 409 }),
  });

  assert.deepEqual(await client.heartbeat(job), { kind: 'interrupted' });
});

test('runs a claimed delivery through the API delivery service', async () => {
  let request: { url: string; body: unknown } | undefined;
  const client = new HttpEngineClient({
    baseUrl: 'https://engine.example.test/',
    workerToken: 'worker-token',
    fetch: async (url, init) => {
      request = { url: String(url), body: JSON.parse(String(init?.body)) };
      return Response.json({ state: 'succeeded' });
    },
  });
  const deliveryId = randomUUID();

  await client.runDelivery({ ...job, stage: 'deliver', deliveryId });

  assert.deepEqual(request, {
    url: `https://engine.example.test/deliveries/${deliveryId}/run`,
    body: { jobId: job.jobId },
  });
});
