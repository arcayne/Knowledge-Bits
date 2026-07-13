import assert from 'node:assert/strict';
import test from 'node:test';

import type { JobResult } from '@knowledge-bits/contracts';
import { calculatePackageChecksum, nextTransition } from '@knowledge-bits/pipeline';

import {
  createInMemoryWorkflowStore,
  type RecordPackageVersionInput,
  WorkflowRepository,
} from './workflow-repository.js';
import {
  FORBIDDEN_NUGLET_ENGINE_ENV,
  assertEngineIsolation,
  createIsolatedPrismaClient,
} from '../config.js';

const checksum = 'a'.repeat(64);
const runId = '0f8fad5b-d9cb-469f-a165-70867728950e';

function createRepository(initialNow = new Date('2026-07-12T12:00:00.000Z')) {
  let identifier = 0;
  let now = new Date(initialNow);
  const repository = new WorkflowRepository(createInMemoryWorkflowStore({
    clock: () => new Date(now),
    idGenerator: () => `test-${++identifier}`,
  }));

  return {
    repository,
    now,
    setNow(value: Date) {
      now = new Date(value);
    },
  };
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

function packageVersionInput(variant: string, revision = 1): RecordPackageVersionInput {
  const material = {
    runId,
    revision,
    adapterVersion: 'review-package@1',
    locale: 'en',
    owner: 'knowledge-bits-engine',
    usageRights: { scope: 'internal-review' },
    content: { schemaVersion: 'knowledge-bits.content.v1' as const, target: { kind: 'nuglet.lesson.v1' as const, payload: { title: `One task ${variant}` } } },
    evidence: { schemaVersion: 'knowledge-bits.evidence.v1' as const, sources: [], claims: [] },
    qa: { deterministic: { passed: true, findings: [] }, editorial: { summary: 'Ready', findings: [] } },
    artifactInventory: [],
  };
  return { ...material, packageChecksum: calculatePackageChecksum({ ...material, assetInventory: material.artifactInventory }) };
}

test('creates and retrieves a workflow run', async () => {
  const { repository } = createRepository();
  const created = await createRun(repository);

  assert.equal((await repository.getRun(created.id))?.title, created.title);
  assert.equal(await repository.getRun('missing'), null);
});

test('bootstraps all workflow stages and the initial research job atomically', async () => {
  const { repository } = createRepository();
  const run = await repository.bootstrapRun({
    id: runId,
    title: 'Build a rainy day fund',
    locale: 'en',
    brief: { lessonSlug: 'build-a-rainy-day-fund' },
  });

  assert.equal(run.currentStage, 'research');
  assert.equal(run.stages.human_review, undefined);
  assert.equal(run.stages.research?.state, 'queued');

  const claim = await repository.claimJob({
    workerId: 'research-worker',
    capabilities: ['collect_sources'],
    leaseSeconds: 60,
  });
  assert.equal(claim?.stage, 'research');
});

test('bootstrap rejects an existing run without overwriting it or its initial job', async () => {
  const { repository } = createRepository();
  await createRun(repository);
  await queueJob(repository, `workflow:${runId}:research:1`);

  await assert.rejects(repository.bootstrapRun({
    id: runId,
    title: 'Replacement run',
    locale: 'en',
    brief: { lessonSlug: 'replacement-run' },
  }));
  assert.equal((await repository.getRun(runId))?.title, 'Build a rainy day fund');
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

test('renewJobLease extends the active lease by its original duration', async () => {
  const { repository, setNow } = createRepository();
  await createRun(repository);
  const queuedJob = await queueJob(repository);
  await repository.claimJob({ workerId: 'worker-a', leaseSeconds: 90 });

  setNow(new Date('2026-07-12T12:00:30.000Z'));
  await repository.renewJobLease({ jobId: queuedJob.id, workerId: 'worker-a' });

  const context = await repository.getJobContext(queuedJob.id);
  assert.equal(context?.job.leaseExpiresAt?.toISOString(), '2026-07-12T12:02:00.000Z');
  await assert.rejects(
    repository.renewJobLease({ jobId: queuedJob.id, workerId: 'worker-b' }),
    /lease/i,
  );
});

test('claimJob filters actions by worker capability', async () => {
  const { repository } = createRepository();
  await createRun(repository);
  await queueJob(repository);

  assert.equal(await repository.claimJob({
    workerId: 'asset-worker',
    capabilities: ['produce_assets'],
    leaseSeconds: 120,
  }), null);
  assert.equal((await repository.claimJob({
    workerId: 'research-worker',
    capabilities: ['collect_sources'],
    leaseSeconds: 120,
  }))?.stage, 'research');
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
  assert.equal((await repository.getRun(runId))?.stages.research?.state, 'queued');

  const reclaimed = await repository.claimJob({
    workerId: 'worker-b',
    leaseSeconds: 120,
    now: reclaimedAt,
  });
  assert.equal(reclaimed?.jobId, queuedJob.id);
  assert.equal(reclaimed?.attempt, 2);
});

test('keeps quality revision attempts separate from expired execution leases', async () => {
  const { repository, now } = createRepository();
  await repository.createRun({
    id: runId,
    title: 'Check retry independence',
    locale: 'en',
    brief: { lessonSlug: 'check-retry-independence' },
    currentStage: 'check',
    stages: [
      { name: 'create', state: 'queued' },
      { name: 'check', state: 'queued' },
    ],
  });
  const job = await repository.queueJob({
    runId,
    stage: 'check',
    action: 'check_content',
    idempotencyKey: 'check-retry-independence',
    input: { brief: 'check retry independence' },
  });
  await repository.claimJob({ workerId: 'check-worker', leaseSeconds: 1 });
  const retryAt = new Date(now.getTime() + 1_001);
  await repository.releaseExpiredLeases({ now: retryAt });
  const claim = await repository.claimJob({ workerId: 'check-worker', leaseSeconds: 60, now: retryAt });
  assert.equal(claim?.attempt, 2);

  const context = await repository.getJobContext(job.id);
  assert.equal(context?.stage.revisionAttempts, 0);
  const transition = nextTransition({
    stage: 'check',
    state: 'running',
    revisionAttempts: context!.stage.revisionAttempts,
    packageChecksum: null,
    approvedChecksum: null,
  }, { type: 'quality_failed', reason: 'missing citations' });
  const run = await repository.applyJobResult({
    workerId: 'check-worker',
    result: {
      jobId: job.id,
      packageId: runId,
      stage: 'check',
      state: 'needs_human',
      completedAt: retryAt.toISOString(),
      outputChecksum: null,
      error: 'missing citations',
    },
    transition,
  });

  assert.equal(run.currentStage, 'create');
  assert.equal(run.stages.create?.revisionAttempts, 1);
  assert.equal(run.stages.human_review, undefined);
});

test('claims revision two through create, check, and asset production after a quality failure', async () => {
  const { repository, now } = createRepository();
  await repository.createRun({
    id: runId,
    title: 'Revision two flow',
    locale: 'en',
    brief: { lessonSlug: 'revision-two-flow' },
    currentStage: 'create',
    stages: [
      { name: 'create', state: 'queued' },
      { name: 'check', state: 'queued' },
      { name: 'produce_assets', state: 'queued' },
    ],
  });
  await repository.queueJob({
    runId,
    stage: 'create',
    action: 'create_content',
    idempotencyKey: 'workflow:revision-two-flow:create:1',
    input: { brief: 'revision two flow' },
  });

  const firstCreate = await repository.claimJob({ workerId: 'create-worker', capabilities: ['create_content'], leaseSeconds: 60 });
  assert.equal(firstCreate?.revision, 1);
  const firstCreateContext = await repository.getJobContext(firstCreate!.jobId);
  await repository.applyJobResult({
    workerId: 'create-worker',
    result: { ...completedResult(firstCreate!.jobId, now), stage: 'create' },
    transition: nextTransition({
      stage: 'create', state: 'running', revisionAttempts: firstCreateContext!.stage.revisionAttempts,
      packageChecksum: null, approvedChecksum: null,
    }, { type: 'stage_completed', packageChecksum: checksum }),
  });
  const firstCheck = await repository.claimJob({ workerId: 'check-worker', capabilities: ['check_content'], leaseSeconds: 60 });
  const firstCheckContext = await repository.getJobContext(firstCheck!.jobId);
  await repository.applyJobResult({
    workerId: 'check-worker',
    result: {
      jobId: firstCheck!.jobId, packageId: runId, stage: 'check', state: 'needs_human',
      completedAt: now.toISOString(), outputChecksum: null, error: 'missing citation',
    },
    transition: nextTransition({
      stage: 'check', state: 'running', revisionAttempts: firstCheckContext!.stage.revisionAttempts,
      packageChecksum: checksum, approvedChecksum: null,
    }, { type: 'quality_failed', reason: 'missing citation' }),
  });

  const revisionTwoCreate = await repository.claimJob({ workerId: 'create-worker', capabilities: ['create_content'], leaseSeconds: 60 });
  assert.equal(revisionTwoCreate?.revision, 2);
  const revisionTwoCreateContext = await repository.getJobContext(revisionTwoCreate!.jobId);
  await repository.applyJobResult({
    workerId: 'create-worker',
    result: { ...completedResult(revisionTwoCreate!.jobId, now), stage: 'create' },
    transition: nextTransition({
      stage: 'create', state: 'running', revisionAttempts: revisionTwoCreateContext!.stage.revisionAttempts,
      packageChecksum: checksum, approvedChecksum: null,
    }, { type: 'stage_completed', packageChecksum: checksum }),
  });
  const revisionTwoCheck = await repository.claimJob({ workerId: 'check-worker', capabilities: ['check_content'], leaseSeconds: 60 });
  assert.equal(revisionTwoCheck?.revision, 2);
  const revisionTwoCheckContext = await repository.getJobContext(revisionTwoCheck!.jobId);
  await repository.applyJobResult({
    workerId: 'check-worker',
    result: { ...completedResult(revisionTwoCheck!.jobId, now), stage: 'check' },
    transition: nextTransition({
      stage: 'check', state: 'running', revisionAttempts: revisionTwoCheckContext!.stage.revisionAttempts,
      packageChecksum: checksum, approvedChecksum: null,
    }, { type: 'stage_completed', packageChecksum: checksum }),
  });
  const revisionTwoAssets = await repository.claimJob({ workerId: 'asset-worker', capabilities: ['produce_assets'], leaseSeconds: 60 });
  assert.equal(revisionTwoAssets?.revision, 2);
});

test('rejects a retry timestamp at or before the repository clock', async () => {
  const { repository, now } = createRepository();
  await createRun(repository);
  const job = await queueJob(repository);
  await repository.claimJob({ workerId: 'worker-a', leaseSeconds: 60 });
  const transition = nextTransition({
    stage: 'research',
    state: 'running',
    revisionAttempts: 0,
    packageChecksum: null,
    approvedChecksum: null,
  }, { type: 'job_waiting', reason: 'provider_cooldown' });

  await assert.rejects(repository.applyJobResult({
    workerId: 'worker-a',
    result: {
      ...completedResult(job.id, now),
      state: 'waiting',
      outputChecksum: null,
      error: 'provider_cooldown',
    },
    transition,
    retryAt: now,
  }), /retry.*future/i);
});

test('replays an identical waiting result after its retry time passes', async () => {
  const { repository, now, setNow } = createRepository();
  await createRun(repository);
  const job = await queueJob(repository);
  await repository.claimJob({ workerId: 'worker-a', leaseSeconds: 60 });
  const retryAt = new Date(now.getTime() + 1_000);
  const result = {
    ...completedResult(job.id, now),
    state: 'waiting' as const,
    outputChecksum: null,
    error: 'provider_cooldown',
  };
  const transition = nextTransition({
    stage: 'research',
    state: 'running',
    revisionAttempts: 0,
    packageChecksum: null,
    approvedChecksum: null,
  }, { type: 'job_waiting', reason: 'provider_cooldown' });

  const first = await repository.applyJobResult({
    workerId: 'worker-a',
    result,
    retryAt,
    transition,
  });
  setNow(new Date(retryAt.getTime() + 1));

  const replay = await repository.applyJobResult({
    workerId: 'worker-a',
    result,
    retryAt,
  });
  assert.deepEqual(replay, first);
  await assert.rejects(repository.applyJobResult({
    workerId: 'worker-a',
    result: { ...result, error: 'different_reason' },
    retryAt,
  }), /conflicts/i);
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

test('applies a persisted transition and queues its declarative next-stage effect', async () => {
  const { repository, now } = createRepository();
  await repository.bootstrapRun({
    id: runId,
    title: 'Build a rainy day fund',
    locale: 'en',
    brief: { lessonSlug: 'build-a-rainy-day-fund' },
  });
  const claim = await repository.claimJob({
    workerId: 'research-worker',
    capabilities: ['collect_sources'],
    leaseSeconds: 60,
  });
  assert.ok(claim);

  const transition = nextTransition({
    stage: 'research',
    state: 'running',
    revisionAttempts: 0,
    packageChecksum: null,
    approvedChecksum: null,
  }, {
    type: 'stage_completed',
    packageChecksum: checksum,
  });
  const run = await repository.applyJobResult({
    workerId: 'research-worker',
    result: completedResult(claim.jobId, now),
    transition,
  });

  assert.equal(run.currentStage, 'create');
  assert.equal(run.stages.research?.state, 'done');
  assert.equal(run.stages.create?.state, 'queued');
  const createClaim = await repository.claimJob({
    workerId: 'create-worker',
    capabilities: ['create_content'],
    leaseSeconds: 60,
  });
  assert.equal(createClaim?.stage, 'create');
});

test('recordArtifact rejects duplicate artifact IDs and storage keys', async () => {
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

  const first = await repository.recordArtifact({
    ...artifact,
    id: '4a3f4c12-5139-4e1d-8ca0-971d380cb8a7',
  });
  await assert.rejects(repository.recordArtifact({
    ...artifact,
    id: first.id,
    revision: 2,
    storageKey: 'runs/one/revision-2/evidence.json',
  }), /artifact id/i);
  await assert.rejects(repository.recordArtifact({
    ...artifact,
    id: 'eb2b0dd0-6d02-4f04-b3e5-82cc17f0547d',
  }), /storage key/i);
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

test('request changes replays by immutable package identity and compares every decision field', async () => {
  const { repository } = createRepository();
  const packageA = packageVersionInput('A');
  await repository.createRun({
    id: runId,
    title: 'Review replay',
    locale: 'en',
    brief: {},
    currentStage: 'human_review',
    packageChecksum: packageA.packageChecksum,
    stages: [{ name: 'human_review', state: 'needs_human' }],
  });
  await repository.recordPackageVersion(packageA);
  const decision = {
    runId,
    packageChecksum: packageA.packageChecksum,
    decision: 'request_changes' as const,
    reviewerId: 'review-principal',
    comment: 'Clarify the practical action.',
  };

  const first = await repository.reviewRun(decision);
  const replay = await repository.reviewRun(decision);

  assert.equal(first.currentRevision, 2);
  assert.equal(replay.currentRevision, 2);
  await assert.rejects(repository.reviewRun({ ...decision, comment: 'Use a different source.' }), /conflict/i);
  await assert.rejects(repository.reviewRun({ ...decision, reviewerId: 'other-principal' }), /conflict/i);
});

test('rejects a package version whose checksum does not match its canonical contents', async () => {
  const { repository } = createRepository();
  await createRun(repository);
  const version = packageVersionInput('canonical');

  await assert.rejects(repository.recordPackageVersion({
    ...version,
    packageChecksum: checksum,
  }), /canonical package contents/i);
});

test('reapproval supersedes stale delivery and claims the newly approved package version', async () => {
  const { repository } = createRepository();
  const packageA = packageVersionInput('A');
  const packageB = packageVersionInput('B');
  await repository.createRun({
    id: runId,
    title: 'Review replacement',
    locale: 'en',
    brief: {},
    currentStage: 'human_review',
    packageChecksum: packageA.packageChecksum,
    stages: [{ name: 'human_review', state: 'needs_human' }],
  });
  const persistedA = await repository.recordPackageVersion(packageA);
  await repository.reviewRun({ runId, packageChecksum: packageA.packageChecksum, decision: 'approve', reviewerId: 'review-principal' });

  const persistedB = await repository.recordPackageVersion(packageB);
  await repository.reviewRun({ runId, packageChecksum: packageB.packageChecksum, decision: 'approve', reviewerId: 'review-principal' });
  const claim = await repository.claimJob({ workerId: 'delivery-worker', capabilities: ['deliver_package'], leaseSeconds: 60 });
  assert.ok(claim);
  const context = await repository.getJobContext(claim.jobId);

  assert.notEqual(persistedA.id, persistedB.id);
  assert.equal(context?.job.input.packageChecksum, packageB.packageChecksum);
  assert.equal(context?.job.input.packageVersionId, persistedB.id);
  assert.ok(context?.job.input.deliveryId);
  assert.equal(context?.approvedChecksum, packageB.packageChecksum);
  assert.equal(await repository.claimJob({ workerId: 'other-worker', capabilities: ['deliver_package'], leaseSeconds: 60 }), null);
});

test('scheduled delivery retry requires its retry time before fencing waiting to running', async () => {
  const { repository, now } = createRepository();
  const packageVersionInputA = packageVersionInput('scheduled-retry');
  await repository.createRun({
    id: runId,
    title: 'Scheduled delivery retry',
    locale: 'en',
    brief: {},
    currentStage: 'human_review',
    packageChecksum: packageVersionInputA.packageChecksum,
    stages: [{ name: 'human_review', state: 'needs_human' }],
  });
  const packageVersion = await repository.recordPackageVersion(packageVersionInputA);
  await repository.reviewRun({
    runId,
    packageChecksum: packageVersion.packageChecksum,
    decision: 'approve',
    reviewerId: 'review-principal',
  });
  const delivery = await repository.getDeliveryForPackage(runId, packageVersion.packageChecksum);
  assert.ok(delivery);
  const initialClaim = await repository.claimJob({
    workerId: 'delivery-worker',
    capabilities: ['deliver_package'],
    leaseSeconds: 60,
  });
  assert.ok(initialClaim);
  const retryAt = new Date(now.getTime() + 60_000);
  const transition = (
    expectedState: string,
    state: string,
    transitionNow: Date,
    nextAttemptAt?: Date | null,
  ) => (
    repository.transitionDeliveryForActiveLease({
      id: delivery.id,
      jobId: initialClaim.jobId,
      workerId: 'delivery-worker',
      packageVersionId: packageVersion.id,
      packageChecksum: packageVersion.packageChecksum,
      expectedState,
      state,
      ...(nextAttemptAt !== undefined ? { nextAttemptAt } : {}),
      now: transitionNow,
    })
  );
  await transition('queued', 'running', now);
  await transition('running', 'waiting', now, retryAt);
  await repository.applyJobResult({
    workerId: 'delivery-worker',
    result: {
      jobId: initialClaim.jobId,
      packageId: runId,
      stage: 'deliver',
      state: 'waiting',
      completedAt: now.toISOString(),
      outputChecksum: null,
      error: 'destination_timeout',
    },
    retryAt,
    transition: nextTransition({
      stage: 'deliver',
      state: 'running',
      revisionAttempts: 0,
      packageChecksum: packageVersion.packageChecksum,
      approvedChecksum: packageVersion.packageChecksum,
    }, { type: 'job_waiting', reason: 'destination_timeout' }),
  });

  const retryClaim = await repository.claimJob({
    workerId: 'delivery-worker',
    capabilities: ['deliver_package'],
    leaseSeconds: 60,
    now: retryAt,
  });
  assert.ok(retryClaim);
  const retryTransition = (transitionNow: Date) => repository.transitionDeliveryForActiveLease({
    id: delivery.id,
    jobId: retryClaim.jobId,
    workerId: 'delivery-worker',
    packageVersionId: packageVersion.id,
    packageChecksum: packageVersion.packageChecksum,
    expectedState: 'waiting',
    state: 'running',
    incrementAttempts: true,
    nextAttemptAt: null,
    now: transitionNow,
  });

  await assert.rejects(retryTransition(new Date(retryAt.getTime() - 1)), /transition fence/i);
  assert.equal((await repository.getDelivery(delivery.id))?.state, 'waiting');
  assert.equal((await retryTransition(retryAt)).state, 'running');
});

test('recordDelivery returns the existing row for its idempotency key', async () => {
  const { repository } = createRepository();
  await createRun(repository);
  const packageVersion = await repository.recordPackageVersion(packageVersionInput('delivery'));
  const first = await repository.recordDelivery({
    runId,
    packageVersionId: packageVersion.id,
    target: 'nuglet.lesson',
    packageChecksum: checksum,
    idempotencyKey: 'delivery-1',
    state: 'queued',
  });
  const second = await repository.recordDelivery({
    runId,
    packageVersionId: packageVersion.id,
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
