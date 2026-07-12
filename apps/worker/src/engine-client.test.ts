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
