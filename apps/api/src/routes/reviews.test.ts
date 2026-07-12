import assert from 'node:assert/strict';
import test from 'node:test';

import { nextTransition } from '@knowledge-bits/pipeline';

import { createApp } from '../app.js';
import {
  createInMemoryWorkflowStore,
  WorkflowRepository,
} from '../repositories/workflow-repository.js';

const checksumA = 'a'.repeat(64);
const checksumB = 'b'.repeat(64);

function createTestApp() {
  const repository = new WorkflowRepository(createInMemoryWorkflowStore());
  return {
    app: createApp({
      repository,
      env: {
        ENGINE_API_TOKEN: 'engine-api-test',
        ENGINE_REVIEW_TOKEN: 'engine-review-test',
      },
    }),
    repository,
  };
}

test('approval freezes the checksum and queues one delivery action', async () => {
  const { app, repository } = createTestApp();
  const runId = await reviewReadyRun(repository, checksumA);

  const first = await app.request(`/runs/${runId}/review`, {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-review-test' },
    body: JSON.stringify({
      decision: 'approve',
      packageChecksum: checksumA,
      reviewerId: 'editor-1',
    }),
  });

  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.deepEqual(firstBody, {
    runId,
    currentStage: 'deliver',
    state: 'queued',
    currentRevision: 1,
    reviewStatus: 'approved',
    packageChecksum: checksumA,
    approvedChecksum: checksumA,
  });

  const replay = await app.request(`/runs/${runId}/review`, {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-review-test' },
    body: JSON.stringify({
      decision: 'approve',
      packageChecksum: checksumA,
      reviewerId: 'editor-1',
    }),
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), firstBody);

  const delivery = await repository.claimJob({
    workerId: 'delivery-worker',
    capabilities: ['deliver_package'],
    leaseSeconds: 60,
  });
  assert.equal(delivery?.stage, 'deliver');
  assert.equal(await repository.claimJob({
    workerId: 'second-delivery-worker',
    capabilities: ['deliver_package'],
    leaseSeconds: 60,
  }), null);
});

test('changes require a comment, bind it to create, and content changes invalidate approval', async () => {
  const { app, repository } = createTestApp();
  const runId = await reviewReadyRun(repository, checksumA);

  const missingComment = await app.request(`/runs/${runId}/review`, {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-review-test' },
    body: JSON.stringify({
      decision: 'request_changes',
      packageChecksum: checksumA,
      reviewerId: 'editor-1',
      comment: '   ',
    }),
  });
  assert.equal(missingComment.status, 400);

  const changes = await app.request(`/runs/${runId}/review`, {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-review-test' },
    body: JSON.stringify({
      decision: 'request_changes',
      packageChecksum: checksumA,
      reviewerId: 'editor-1',
      comment: 'Add the primary source to the learner copy.',
    }),
  });
  assert.equal(changes.status, 200);
  assert.equal((await changes.json()).currentRevision, 2);

  const create = await repository.claimJob({
    workerId: 'create-worker',
    capabilities: ['create_content'],
    leaseSeconds: 60,
  });
  assert.equal(create?.stage, 'create');
  const context = await repository.getJobContext(create!.jobId);
  assert.deepEqual(context?.job.input.review, {
    comment: 'Add the primary source to the learner copy.',
    packageChecksum: checksumA,
  });

  const approvedRunId = await reviewReadyRun(repository, checksumA);
  const approved = await app.request(`/runs/${approvedRunId}/review`, {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-review-test' },
    body: JSON.stringify({ decision: 'approve', packageChecksum: checksumA, reviewerId: 'editor-1' }),
  });
  assert.equal(approved.status, 200);

  const changed = await repository.recordPackageChange({ runId: approvedRunId, packageChecksum: checksumB });
  assert.equal(changed.currentStage, 'human_review');
  assert.equal(changed.reviewStatus, 'pending');
  assert.equal(changed.approvedChecksum, null);
});

test('only the run-level review endpoint is available', async () => {
  const { app, repository } = createTestApp();
  const runId = await reviewReadyRun(repository, checksumA);

  const artifactRoute = await app.request(`/runs/${runId}/artifacts/asset-1/review`, {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-review-test' },
    body: JSON.stringify({ decision: 'approve', packageChecksum: checksumA, reviewerId: 'editor-1' }),
  });

  assert.equal(artifactRoute.status, 404);
});

async function reviewReadyRun(repository: WorkflowRepository, checksum: string): Promise<string> {
  const run = await repository.bootstrapRun({
    title: 'Build a rainy day fund',
    locale: 'en',
    brief: { objective: 'Build one practical learner lesson.' },
  });
  const capabilities = ['collect_sources', 'create_content', 'check_content', 'produce_assets'] as const;

  for (const capability of capabilities) {
    const claim = await repository.claimJob({ workerId: `${capability}-worker`, capabilities: [capability], leaseSeconds: 60 });
    assert.ok(claim);
    const context = await repository.getJobContext(claim.jobId);
    assert.ok(context);
    await repository.applyJobResult({
      workerId: `${capability}-worker`,
      result: {
        jobId: claim.jobId,
        packageId: run.id,
        stage: claim.stage,
        state: 'done',
        completedAt: '2026-07-13T10:00:00.000Z',
        outputChecksum: checksum,
        error: null,
      },
      transition: nextTransition({
        stage: claim.stage,
        state: 'running',
        revisionAttempts: context.stage.revisionAttempts,
        packageChecksum: context.packageChecksum as `${string}` | null,
        approvedChecksum: context.approvedChecksum as `${string}` | null,
      }, { type: 'stage_completed', packageChecksum: checksum as `${string}` }),
    });
  }

  return run.id;
}
