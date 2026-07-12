import assert from 'node:assert/strict';
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
      ENGINE_WORKER_TOKEN: 'engine-worker-test',
      ENGINE_REVIEW_TOKEN: 'engine-review-test',
    },
  });
}

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
    body: JSON.stringify({
      workerId: 'research-worker',
      capabilities: ['collect_sources'],
      leaseSeconds: 120,
    }),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ jobId: string; packageId: string; stage: 'research' }>;
}

test('claims only jobs supported by worker capabilities', async () => {
  const app = createTestApp();
  await createRun(app);

  const unsupported = await app.request('/jobs/claim', {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-worker-test' },
    body: JSON.stringify({ workerId: 'asset-worker', capabilities: ['produce_assets'], leaseSeconds: 120 }),
  });
  assert.equal(unsupported.status, 204);

  const claim = await claimResearchJob(app);
  assert.deepEqual(jobClaimSchema.parse(claim).stage, 'research');
});

test('requires the worker token to claim jobs', async () => {
  const app = createTestApp();
  await createRun(app);

  const response = await app.request('/jobs/claim', {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-api-test' },
    body: JSON.stringify({ workerId: 'research-worker', capabilities: ['collect_sources'], leaseSeconds: 120 }),
  });
  assert.equal(response.status, 403);
});

test('rejects a result reported by a different lease owner', async () => {
  const app = createTestApp();
  await createRun(app);
  const claim = await claimResearchJob(app);

  const response = await app.request(`/jobs/${claim.jobId}/result`, {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-worker-test' },
    body: JSON.stringify({
      workerId: 'other-worker',
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
      workerId: 'research-worker',
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
