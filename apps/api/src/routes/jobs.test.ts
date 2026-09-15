import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { jobClaimSchema } from '@knowledge-bits/contracts';

import { createApp } from '../app.js';
import {
  createInMemoryWorkflowStore,
  WorkflowRepository,
} from '../repositories/workflow-repository.js';
import type { ArtifactStorageAdapter } from '../services/artifacts.js';

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

test('renews only the current worker lease through the heartbeat endpoint', async () => {
  const app = createPrincipalBoundTestApp();
  await createRun(app);
  const claimResponse = await app.request('/jobs/claim', {
    method: 'POST',
    headers: { Authorization: 'Bearer research-worker-token' },
    body: JSON.stringify({ leaseSeconds: 120 }),
  });
  assert.equal(claimResponse.status, 200);
  const claim = await claimResponse.json() as { jobId: string };

  const renewed = await app.request(`/jobs/${claim.jobId}/heartbeat`, {
    method: 'POST',
    headers: { Authorization: 'Bearer research-worker-token' },
  });
  assert.equal(renewed.status, 204);

  const rejected = await app.request(`/jobs/${claim.jobId}/heartbeat`, {
    method: 'POST',
    headers: { Authorization: 'Bearer asset-worker-token' },
  });
  assert.equal(rejected.status, 409);
});

test('binds a server-provisioned NotebookLM ID through the active research lease', async () => {
  const app = createPrincipalBoundTestApp();
  const created = await app.request('/runs/joan', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer engine-api-test',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }),
  });
  assert.equal(created.status, 201);
  const run = await created.json() as { id: string };
  const claim = await claimResearchJob(app, 'research-worker-token');

  const bound = await app.request(`/jobs/${claim.jobId}/notebook`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer research-worker-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ notebookLmNotebookId: 'provisioned-notebook' }),
  });
  assert.equal(bound.status, 204);

  const retrieved = await app.request(`/runs/${run.id}`, {
    headers: { Authorization: 'Bearer engine-api-test' },
  });
  assert.equal(retrieved.status, 200);
  assert.equal((await retrieved.json()).notebookLmNotebookId, 'provisioned-notebook');
});

test('serves only declared artifact dependencies through the active worker lease', async () => {
  const repository = new WorkflowRepository(createInMemoryWorkflowStore());
  const dependencyId = '55555555-5555-4555-8555-555555555555';
  const otherId = '66666666-6666-4666-8666-666666666666';
  await repository.createRun({
    id: '77777777-7777-4777-8777-777777777777',
    title: 'Lease scoped context',
    locale: 'en',
    brief: { title: 'Lease scoped context' },
    currentStage: 'create',
    stages: [{ name: 'create', state: 'queued' }],
  });
  for (const [artifactId, storageKey] of [[dependencyId, 'objects/dependency'], [otherId, 'objects/other']]) {
    await repository.recordArtifact({
      id: artifactId,
      runId: '77777777-7777-4777-8777-777777777777',
      revision: 1,
      kind: 'parsed_output',
      mediaType: 'application/json',
      checksum,
      storageKey,
      byteSize: 2,
      provenance: { provider: 'fixture' },
      inputChecksum: null,
      action: 'collect_sources',
      stage: 'research',
    });
  }
  await repository.queueJob({
    runId: '77777777-7777-4777-8777-777777777777',
    stage: 'create',
    action: 'create_content',
    idempotencyKey: 'lease-scoped-context',
    input: {
      brief: { title: 'Lease scoped context' },
      dependencies: [{ artifactId: dependencyId, revision: 1, kind: 'parsed_output', mediaType: 'application/json', checksum, action: 'collect_sources' }],
    },
  });
  const storage: ArtifactStorageAdapter = {
    async preparePut() { throw new Error('not used'); },
    async inspect() { throw new Error('not used'); },
    async read(storageKey) { return Buffer.from(storageKey === 'objects/dependency' ? '{}' : 'other'); },
  };
  const app = createApp({
    repository,
    artifactStorage: storage,
    env: {
      ENGINE_WORKER_CREDENTIALS: JSON.stringify([{
        token: 'create-worker-token', workerId: 'create-worker', capabilities: ['create_content'],
      }]),
    },
  });
  const claimResponse = await app.request('/jobs/claim', {
    method: 'POST',
    headers: { Authorization: 'Bearer create-worker-token' },
    body: JSON.stringify({ leaseSeconds: 120 }),
  });
  const claim = await claimResponse.json() as { jobId: string; input: Record<string, unknown>; executionDeadlineAt: string };
  assert.ok(Array.isArray(claim.input.dependencies));
  assert.ok(new Date(claim.executionDeadlineAt) > new Date());

  const allowed = await app.request(`/jobs/${claim.jobId}/artifacts/${dependencyId}`, {
    headers: { Authorization: 'Bearer create-worker-token' },
  });
  assert.equal(allowed.status, 200, await allowed.clone().text());
  assert.equal(await allowed.text(), '{}');
  const denied = await app.request(`/jobs/${claim.jobId}/artifacts/${otherId}`, {
    headers: { Authorization: 'Bearer create-worker-token' },
  });
  assert.equal(denied.status, 409);
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
  const repository = new WorkflowRepository(createInMemoryWorkflowStore());
  const app = createApp({
    repository,
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
  await createRun(app);
  const claim = await claimResearchJob(app);
  const contextBeforeCompletion = await repository.getJobContext(claim.jobId);
  assert.ok(contextBeforeCompletion);
  const staleContext = structuredClone(contextBeforeCompletion);
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

  repository.getJobContext = async () => staleContext;

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

async function claimResearchJob(app: ReturnType<typeof createTestApp>, token = 'engine-worker-test') {
  const response = await app.request('/jobs/claim', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
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

test('keeps non-Check quality failures in the current stage for human action', async () => {
  const app = createTestApp();
  await createRun(app);
  const claim = await claimResearchJob(app);

  const response = await app.request(`/jobs/${claim.jobId}/result`, {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-worker-test' },
    body: JSON.stringify({
      result: {
        jobId: claim.jobId,
        packageId: claim.packageId,
        stage: claim.stage,
        state: 'needs_human',
        completedAt: '2026-07-12T12:00:00.000Z',
        outputChecksum: null,
        error: 'source_snapshot_unreadable',
        needsHumanKind: 'quality',
      },
    }),
  });

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.currentStage, 'research');
  assert.equal(body.stages.research.state, 'needs_human');
  assert.equal(body.stages.research.reason, 'source_snapshot_unreadable');
});
