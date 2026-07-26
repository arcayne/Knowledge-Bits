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
  executionDeadlineAt: '2026-07-12T18:05:00.000Z',
  attempt: 1,
  revision: 1,
  input: { brief: {}, dependencies: [] },
};

test('maps a renewed heartbeat response to continue', async () => {
  const client = new HttpEngineClient({
    baseUrl: 'https://engine.example.test',
    workerToken: 'worker-token',
    fetch: async () => new Response(null, { status: 204 }),
  });

  assert.deepEqual(await client.heartbeat(job), { kind: 'continue' });
});

test('sends optional run affinity when claiming the next job', async () => {
  let body: unknown;
  const client = new HttpEngineClient({
    baseUrl: 'https://engine.example.test',
    workerToken: 'worker-token',
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(null, { status: 204 });
    },
  });

  await client.claim(60, job.packageId);

  assert.deepEqual(body, { leaseSeconds: 60, preferredRunId: job.packageId });
});

test('reads a declared artifact through the job-scoped control API', async () => {
  let requestedUrl = '';
  const artifactId = randomUUID();
  const client = new HttpEngineClient({
    baseUrl: 'https://engine.example.test',
    workerToken: 'worker-token',
    fetch: async (url) => {
      requestedUrl = String(url);
      return new Response('evidence bytes', { headers: { 'Content-Type': 'application/json' } });
    },
  });

  const artifact = await client.readArtifact(job, artifactId);

  assert.equal(requestedUrl, `https://engine.example.test/jobs/${job.jobId}/artifacts/${artifactId}`);
  assert.equal(Buffer.from(artifact.body).toString(), 'evidence bytes');
  assert.equal(artifact.mediaType, 'application/json');
});

test('bounds control API requests with an aborting deadline', async () => {
  const client = new HttpEngineClient({
    baseUrl: 'https://engine.example.test',
    workerToken: 'worker-token',
    requestTimeoutMs: 5,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }),
  });

  await assert.rejects(client.claim(60), /timed out/i);
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
