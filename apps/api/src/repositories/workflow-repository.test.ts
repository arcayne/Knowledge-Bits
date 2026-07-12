import assert from 'node:assert/strict';
import test from 'node:test';

import type { JobResult } from '@knowledge-bits/contracts';

import {
  createInMemoryWorkflowStore,
  WorkflowRepository,
} from './workflow-repository.js';
import {
  FORBIDDEN_NUGLET_ENGINE_ENV,
  assertEngineIsolation,
  createIsolatedPrismaClient,
} from '../config.js';

const checksum = 'a'.repeat(64);
const runId = '0f8fad5b-d9cb-469f-a165-70867728950e';

function createRepository(now = new Date('2026-07-12T12:00:00.000Z')) {
  let identifier = 0;
  const repository = new WorkflowRepository(createInMemoryWorkflowStore({
    clock: () => new Date(now),
    idGenerator: () => `test-${++identifier}`,
  }));

  return { repository, now };
}

async function createRun(repository: WorkflowRepository) {
  return repository.createRun({
    id: runId,
    title: 'Build a rainy day fund',
    locale: 'en',
    brief: { lessonSlug: 'build-a-rainy-day-fund' },
    currentStage: 'research',
  });
}

async function queueJob(repository: WorkflowRepository, idempotencyKey = 'research-1') {
  return repository.queueJob({
    runId,
    stage: 'research',
    action: 'collect_sources',
    idempotencyKey,
    input: { query: 'emergency fund advice' },
  });
}

function completedResult(jobId: string, completedAt: Date): JobResult {
  return {
    jobId,
    packageId: runId,
    stage: 'research',
    state: 'done',
    completedAt: completedAt.toISOString(),
    outputChecksum: checksum,
    error: null,
  };
}

test('creates and retrieves a workflow run', async () => {
  const { repository } = createRepository();
  const created = await createRun(repository);

  assert.equal((await repository.getRun(created.id))?.title, created.title);
  assert.equal(await repository.getRun('missing'), null);
});

test('claimJob leases one eligible job once', async () => {
  const { repository } = createRepository();
  await createRun(repository);
  const queuedJob = await queueJob(repository);

  const first = await repository.claimJob({ workerId: 'worker-a', leaseSeconds: 120 });
  const second = await repository.claimJob({ workerId: 'worker-b', leaseSeconds: 120 });

  assert.equal(first?.jobId, queuedJob.id);
  assert.equal(second, null);
});

test('claimJob rejects a blank worker id before creating a lease', async () => {
  const { repository } = createRepository();
  await createRun(repository);
  await queueJob(repository);

  await assert.rejects(
    repository.claimJob({ workerId: '   ', leaseSeconds: 120 }),
    /worker id/i,
  );
});

test('releaseExpiredLeases makes an expired job eligible for another worker', async () => {
  const { repository, now } = createRepository();
  await createRun(repository);
  const queuedJob = await queueJob(repository);
  await repository.claimJob({ workerId: 'worker-a', leaseSeconds: 1 });

  const reclaimedAt = new Date(now.getTime() + 1_001);
  assert.equal(await repository.releaseExpiredLeases({ now: reclaimedAt }), 1);

  const reclaimed = await repository.claimJob({
    workerId: 'worker-b',
    leaseSeconds: 120,
    now: reclaimedAt,
  });
  assert.equal(reclaimed?.jobId, queuedJob.id);
  assert.equal(reclaimed?.attempt, 2);
});

test('completeJob requires the current unexpired lease owner', async () => {
  const { repository, now } = createRepository();
  await createRun(repository);
  const job = await queueJob(repository);
  await repository.claimJob({ workerId: 'worker-a', leaseSeconds: 60 });

  await assert.rejects(
    repository.completeJob({
      workerId: 'worker-b',
      result: completedResult(job.id, now),
    }),
    /lease/i,
  );

  assert.deepEqual(
    await repository.completeJob({
      workerId: 'worker-a',
      result: completedResult(job.id, now),
    }),
    completedResult(job.id, now),
  );
});

test('completeJob uses the repository clock instead of the worker completion timestamp', async () => {
  const { repository, now } = createRepository();
  await createRun(repository);
  const job = await queueJob(repository);
  await repository.claimJob({ workerId: 'worker-a', leaseSeconds: 60 });

  const workerSuppliedFuture = new Date(now.getTime() + 24 * 60 * 60 * 1_000);
  const result = completedResult(job.id, workerSuppliedFuture);

  assert.deepEqual(
    await repository.completeJob({ workerId: 'worker-a', result }),
    result,
  );
});

test('recordArtifact rejects a duplicate storage key', async () => {
  const { repository } = createRepository();
  await createRun(repository);
  const artifact = {
    runId,
    revision: 1,
    kind: 'evidence',
    mediaType: 'application/json',
    checksum,
    storageKey: 'runs/one/evidence.json',
    byteSize: 128,
    provenance: { provider: 'fixture' },
    inputChecksum: null,
  };

  await repository.recordArtifact(artifact);
  await assert.rejects(repository.recordArtifact(artifact), /storage key/i);
});

test('recordReview returns the existing review for an identical request', async () => {
  const { repository } = createRepository();
  await createRun(repository);
  const review = {
    runId,
    revision: 1,
    packageChecksum: checksum,
    decision: 'approved',
    reviewerId: 'operator-1',
    comment: null,
  };

  const first = await repository.recordReview(review);
  const second = await repository.recordReview(review);

  assert.equal(second.id, first.id);
});

test('recordReview rejects a conflicting decision for the same package checksum', async () => {
  const { repository } = createRepository();
  await createRun(repository);
  const review = {
    runId,
    revision: 1,
    packageChecksum: checksum,
    decision: 'approved',
    reviewerId: 'operator-1',
    comment: null,
  };

  await repository.recordReview(review);
  await assert.rejects(
    repository.recordReview({ ...review, decision: 'rejected' }),
    /review.*conflict/i,
  );
});

test('recordReview allows a new package checksum for the same revision', async () => {
  const { repository } = createRepository();
  await createRun(repository);
  const review = {
    runId,
    revision: 1,
    packageChecksum: checksum,
    decision: 'approved',
    reviewerId: 'operator-1',
    comment: null,
  };

  await repository.recordReview(review);
  const revisionWithNewChecksum = await repository.recordReview({
    ...review,
    packageChecksum: 'b'.repeat(64),
  });

  assert.equal(revisionWithNewChecksum.packageChecksum, 'b'.repeat(64));
});

test('recordDelivery returns the existing row for its idempotency key', async () => {
  const { repository } = createRepository();
  await createRun(repository);
  const first = await repository.recordDelivery({
    runId,
    target: 'nuglet.lesson',
    packageChecksum: checksum,
    idempotencyKey: 'delivery-1',
    state: 'queued',
  });
  const second = await repository.recordDelivery({
    runId,
    target: 'changed-target',
    packageChecksum: 'b'.repeat(64),
    idempotencyKey: 'delivery-1',
    state: 'queued',
  });

  assert.equal(second.id, first.id);
  assert.equal(second.target, first.target);
  assert.equal(second.packageChecksum, first.packageChecksum);
});

for (const name of FORBIDDEN_NUGLET_ENGINE_ENV) {
  test(`assertEngineIsolation rejects ${name} without exposing its value`, () => {
    const secret = `never-print-${name}`;
    let message = '';

    assert.throws(() => assertEngineIsolation({ [name]: secret }), (error: unknown) => {
      message = error instanceof Error ? error.message : String(error);
      return true;
    });

    assert.match(message, new RegExp(name));
    assert.doesNotMatch(message, new RegExp(secret));
    assert.throws(
      () => createIsolatedPrismaClient({
        ENGINE_DATABASE_URL: 'postgresql://localhost:5432/knowledge_bits_engine',
        [name]: secret,
      }),
      new RegExp(name),
    );
  });
}

test('createIsolatedPrismaClient requires ENGINE_DATABASE_URL and rejects DATABASE_URL', async () => {
  assert.throws(
    () => createIsolatedPrismaClient({ DATABASE_URL: 'postgresql://localhost/plain' }),
    /DATABASE_URL.*ENGINE_DATABASE_URL/i,
  );
  assert.throws(
    () => createIsolatedPrismaClient({}),
    /ENGINE_DATABASE_URL.*required/i,
  );

  const client = createIsolatedPrismaClient({
    ENGINE_DATABASE_URL: 'postgresql://localhost:5432/knowledge_bits_engine',
  });
  await client.$disconnect();
});
