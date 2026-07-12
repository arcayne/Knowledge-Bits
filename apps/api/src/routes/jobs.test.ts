import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { jobClaimSchema } from '@knowledge-bits/contracts';

import { createApp } from '../app.js';
import {
  createInMemoryWorkflowStore,
  WorkflowRepository,
} from '../repositories/workflow-repository.js';

const checksum = 'a'.repeat(64);
const validBrief = { audience: 'People rebuilding focus', objective: 'Create one practical lesson' };

function createTestApp() {
  return createApp({
    repository: new WorkflowRepository(createInMemoryWorkflowStore()),
    env: {
      ENGINE_API_TOKEN: 'engine-api-test',
      ENGINE_REVIEW_TOKEN: 'engine-review-test',
      ENGINE_WORKER_CREDENTIALS: JSON.stringify([{
        token: 'engine-worker-test',
        workerId: 'research-worker',
        capabilities: ['collect_sources'],
      }]),
    },
  });
}

function createPrincipalBoundTestApp() {
  return createApp({
    repository: new WorkflowRepository(createInMemoryWorkflowStore()),
    env: {
      ENGINE_API_TOKEN: 'engine-api-test',
      ENGINE_REVIEW_TOKEN: 'engine-review-test',
      ENGINE_WORKER_CREDENTIALS: JSON.stringify([
        {
          token: 'research-worker-token',
          workerId: 'research-worker',
          capabilities: ['collect_sources'],
        },
        {
          token: 'asset-worker-token',
          workerId: 'asset-worker',
          capabilities: ['produce_assets'],
        },
      ]),
    },
  });
}

test('derives worker identity and capabilities from the worker credential', async () => {
  const app = createPrincipalBoundTestApp();
  await createRun(app);

  const escalatedClaim = await app.request('/jobs/claim', {
    method: 'POST',
    headers: { Authorization: 'Bearer asset-worker-token' },
    body: JSON.stringify({
      workerId: 'research-worker',
      capabilities: ['collect_sources'],
      leaseSeconds: 120,
    }),
  });
  assert.equal(escalatedClaim.status, 400);

  const assetClaim = await app.request('/jobs/claim', {
    method: 'POST',
    headers: { Authorization: 'Bearer asset-worker-token' },
    body: JSON.stringify({ leaseSeconds: 120 }),
  });
  assert.equal(assetClaim.status, 204);

  const researchClaim = await app.request('/jobs/claim', {
    method: 'POST',
    headers: { Authorization: 'Bearer research-worker-token' },
    body: JSON.stringify({ leaseSeconds: 120 }),
  });
  assert.equal(researchClaim.status, 200);
  const claim = await researchClaim.json() as { jobId: string; packageId: string; stage: 'research' };
  assert.equal(claim.stage, 'research');

  const impersonatedResult = await app.request(`/jobs/${claim.jobId}/result`, {
    method: 'POST',
    headers: { Authorization: 'Bearer asset-worker-token' },
    body: JSON.stringify({
      workerId: 'research-worker',
      result: {
        jobId: claim.jobId,
        packageId: claim.packageId,
        stage: claim.stage,
        state: 'done',
        completedAt: '2026-07-12T12:00:00.000Z',
        outputChecksum: checksum,
        error: null,
      },
    }),
  });
  assert.equal(impersonatedResult.status, 400);
});

test('replays an identical completed result and rejects a conflicting retry', async () => {
  const app = createPrincipalBoundTestApp();
  await createRun(app);
  const claimResponse = await app.request('/jobs/claim', {
    method: 'POST',
    headers: { Authorization: 'Bearer research-worker-token' },
    body: JSON.stringify({ leaseSeconds: 120 }),
  });
  assert.equal(claimResponse.status, 200);
  const claim = await claimResponse.json() as { jobId: string; packageId: string; stage: 'research' };
  const result = {
    jobId: claim.jobId,
    packageId: claim.packageId,
    stage: claim.stage,
    state: 'done',
    completedAt: '2026-07-12T12:00:00.000Z',
    outputChecksum: checksum,
    error: null,
  } as const;

  const first = await app.request(`/jobs/${claim.jobId}/result`, {
    method: 'POST',
    headers: { Authorization: 'Bearer research-worker-token' },
    body: JSON.stringify({ result }),
  });
  assert.equal(first.status, 200, await first.clone().text());
  const firstBody = await first.json();

  const replay = await app.request(`/jobs/${claim.jobId}/result`, {
    method: 'POST',
    headers: { Authorization: 'Bearer research-worker-token' },
    body: JSON.stringify({ result }),
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), firstBody);

  const conflict = await app.request(`/jobs/${claim.jobId}/result`, {
    method: 'POST',
    headers: { Authorization: 'Bearer research-worker-token' },
    body: JSON.stringify({ result: { ...result, outputChecksum: 'b'.repeat(64) } }),
  });
  assert.equal(conflict.status, 409);
});

test('rejects retry times that are not in the future', async () => {
  const app = createPrincipalBoundTestApp();
  await createRun(app);
  const claimResponse = await app.request('/jobs/claim', {
    method: 'POST',
    headers: { Authorization: 'Bearer research-worker-token' },
    body: JSON.stringify({ leaseSeconds: 120 }),
  });
  const claim = await claimResponse.json() as { jobId: string; packageId: string; stage: 'research' };

  const response = await app.request(`/jobs/${claim.jobId}/result`, {
    method: 'POST',
    headers: { Authorization: 'Bearer research-worker-token' },
    body: JSON.stringify({
      retryAt: '2000-01-01T00:00:00.000Z',
      result: {
        jobId: claim.jobId,
        packageId: claim.packageId,
        stage: claim.stage,
        state: 'waiting',
        completedAt: '2026-07-12T12:00:00.000Z',
        outputChecksum: null,
        error: 'provider_cooldown',
      },
    }),
  });
  assert.equal(response.status, 400);
});

test('replays a waiting result after its retry time passes', async () => {
  const app = createTestApp();
  await createRun(app);
  const claim = await claimResearchJob(app);
  const retryAt = new Date(Date.now() + 600).toISOString();
  const result = {
    jobId: claim.jobId,
    packageId: claim.packageId,
    stage: claim.stage,
    state: 'waiting',
    completedAt: '2026-07-12T12:00:00.000Z',
    outputChecksum: null,
    error: 'provider_cooldown',
  };
  const request = {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-worker-test' },
    body: JSON.stringify({ retryAt, result }),
  };

  const first = await app.request(`/jobs/${claim.jobId}/result`, request);
  assert.equal(first.status, 200, await first.clone().text());
  const firstBody = await first.json();
  await delay(750);

  const replay = await app.request(`/jobs/${claim.jobId}/result`, request);
  assert.equal(replay.status, 200, await replay.clone().text());
  assert.deepEqual(await replay.json(), firstBody);

  const conflict = await app.request(`/jobs/${claim.jobId}/result`, {
    ...request,
    body: JSON.stringify({
      retryAt,
      result: { ...result, error: 'different_reason' },
    }),
  });
  assert.equal(conflict.status, 409);
});

async function createRun(app: ReturnType<typeof createTestApp>) {
  const response = await app.request('/runs', {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-api-test' },
    body: JSON.stringify({ title: 'Attention recovery', locale: 'en', brief: validBrief }),
  });
  assert.equal(response.status, 201);
  return response.json() as Promise<{ id: string }>;
}

async function claimResearchJob(app: ReturnType<typeof createTestApp>) {
  const response = await app.request('/jobs/claim', {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-worker-test' },
    body: JSON.stringify({ leaseSeconds: 120 }),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ jobId: string; packageId: string; stage: 'research' }>;
}

test('rejects request-supplied worker capabilities', async () => {
  const app = createTestApp();
  await createRun(app);

  const unsupported = await app.request('/jobs/claim', {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-worker-test' },
    body: JSON.stringify({ leaseSeconds: 120, capabilities: ['produce_assets'] }),
  });
  assert.equal(unsupported.status, 400);

  const claim = await claimResearchJob(app);
  assert.deepEqual(jobClaimSchema.parse(claim).stage, 'research');
});

test('requires the worker token to claim jobs', async () => {
  const app = createTestApp();
  await createRun(app);

  const response = await app.request('/jobs/claim', {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-api-test' },
    body: JSON.stringify({ leaseSeconds: 120 }),
  });
  assert.equal(response.status, 403);
});

test('rejects a result reported by a different lease owner', async () => {
  const app = createPrincipalBoundTestApp();
  await createRun(app);
  const claimResponse = await app.request('/jobs/claim', {
    method: 'POST',
    headers: { Authorization: 'Bearer research-worker-token' },
    body: JSON.stringify({ leaseSeconds: 120 }),
  });
  const claim = await claimResponse.json() as { jobId: string; packageId: string; stage: 'research' };

  const response = await app.request(`/jobs/${claim.jobId}/result`, {
    method: 'POST',
    headers: { Authorization: 'Bearer asset-worker-token' },
    body: JSON.stringify({
      result: {
        jobId: claim.jobId,
        packageId: claim.packageId,
        stage: claim.stage,
        state: 'done',
        completedAt: '2026-07-12T12:00:00.000Z',
        outputChecksum: checksum,
        error: null,
      },
    }),
  });
  assert.equal(response.status, 409);
});

test('persists a waiting outcome and its retry time', async () => {
  const app = createTestApp();
  await createRun(app);
  const claim = await claimResearchJob(app);
  const retryAt = '2030-01-01T00:00:00.000Z';

  const response = await app.request(`/jobs/${claim.jobId}/result`, {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-worker-test' },
    body: JSON.stringify({
      retryAt,
      result: {
        jobId: claim.jobId,
        packageId: claim.packageId,
        stage: claim.stage,
        state: 'waiting',
        completedAt: '2026-07-12T12:00:00.000Z',
        outputChecksum: null,
        error: 'notebooklm_cooldown',
      },
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.stages.research.state, 'waiting');
  assert.equal(body.nextRetryAt, retryAt);
});
