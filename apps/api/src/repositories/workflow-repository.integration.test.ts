import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import test from 'node:test';

import { nextTransition } from '@knowledge-bits/pipeline';

import { createIsolatedPrismaClient } from '../config.js';
import {
  createWorkflowRepository,
  WorkflowConflictError,
} from './workflow-repository.js';
import { strictLegacyReplacementBrief, strictPackageVersionInput } from '../testing/knowledge-bits-fixture.js';

const apiRoot = fileURLToPath(new URL('../../', import.meta.url));
const dockerUnavailable = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 30_000 }).status !== 0;

test(
  'local PostgreSQL migration preserves bootstrap, effects, leases, retries, and idempotent results',
  { skip: dockerUnavailable ? 'Docker is unavailable; migration SQL contract test still runs' : false, timeout: 120_000 },
  async (t) => {
    const containerName = `knowledge-bits-api-test-${randomUUID()}`;
    const databaseName = 'knowledge_bits_test';
    const databaseUrl = await startPostgres(containerName, databaseName);
    t.after(() => removeContainer(containerName));

    await deployMigrations(databaseUrl);
    const runtimeDatabaseUrl = createRestrictedRuntimeLogin(containerName, databaseName, databaseUrl);

    const prisma = createIsolatedPrismaClient({ ENGINE_DATABASE_URL: runtimeDatabaseUrl });
    t.after(() => prisma.$disconnect());
    const identity = await prisma.$queryRaw<Array<{ currentUser: string; canCreate: boolean }>>`
      SELECT current_user AS "currentUser", has_schema_privilege(current_user, 'public', 'CREATE') AS "canCreate"
    `;
    assert.equal(identity[0]?.currentUser, 'knowledge_bits_runtime_login');
    assert.equal(identity[0]?.canCreate, false);
    await assert.rejects(
      prisma.$executeRawUnsafe('CREATE TABLE "runtime_must_not_create" ("id" text)'),
      /permission denied/i,
    );
    await assert.rejects(
      prisma.$executeRawUnsafe('DELETE FROM "_prisma_migrations"'),
      /permission denied/i,
    );
    const repository = createWorkflowRepository(prisma);
    const runId = '0f8fad5b-d9cb-469f-a165-70867728950e';

    const bootstrapped = await repository.bootstrapRun({
      id: runId,
      title: 'Database workflow integration',
      locale: 'en',
      brief: { source: 'integration-test' },
    });
    assert.equal(bootstrapped.stages.human_review, undefined);

    const duplicateArtifact = {
      id: '4a3f4c12-5139-4e1d-8ca0-971d380cb8a7',
      runId,
      revision: 1,
      kind: 'evidence',
      mediaType: 'application/json',
      checksum,
      storageKey: 'integration/artifacts/evidence.json',
      byteSize: 128,
      provenance: { provider: 'integration' },
      inputChecksum: null,
    };
    await repository.recordArtifact(duplicateArtifact);
    await assert.rejects(repository.recordArtifact({
      ...duplicateArtifact,
      revision: 2,
      storageKey: 'integration/artifacts/revision-2/evidence.json',
    }), /artifact id/i);
    await assert.rejects(repository.recordArtifact({
      ...duplicateArtifact,
      id: 'eb2b0dd0-6d02-4f04-b3e5-82cc17f0547d',
    }), /storage key/i);

    const artifactRunId = 'f2db3276-82f5-4ec6-93d0-4d873a4dce01';
    await repository.createRun({
      id: artifactRunId,
      title: 'Database artifact authorization',
      locale: 'en',
      brief: { source: 'artifact-test' },
      currentStage: 'produce_assets',
      currentRevision: 2,
      stages: [{ name: 'produce_assets', state: 'queued' }],
    });
    const artifactJob = await repository.queueJob({
      runId: artifactRunId,
      stage: 'produce_assets',
      action: 'produce_assets',
      idempotencyKey: 'integration-artifact-job',
      input: { kind: 'evidence' },
    });
    await repository.claimJob({
      workerId: 'asset-worker',
      capabilities: ['produce_assets'],
      leaseSeconds: 120,
    });
    const authorizedArtifact = {
      id: '7cc77a84-7d6b-4ef3-b05b-b47cfe8c857b',
      runId: artifactRunId,
      revision: 2,
      kind: 'evidence',
      mediaType: 'application/json',
      checksum,
      storageKey: 'integration/artifacts/authorized.json',
      byteSize: 256,
      provenance: {
        provider: 'integration',
        action: 'collect_sources',
        stage: 'research',
        jobId: '99999999-9999-4999-8999-999999999999',
      },
      inputChecksum: null,
    };
    const persistedAuthorizedArtifact = await repository.recordArtifactForActiveLease({
      workerId: 'asset-worker',
      jobId: artifactJob.id,
      ...authorizedArtifact,
    });
    assert.equal(persistedAuthorizedArtifact.id, authorizedArtifact.id);
    assert.equal(persistedAuthorizedArtifact.provenance.action, 'produce_assets');
    assert.equal(persistedAuthorizedArtifact.provenance.stage, 'produce_assets');
    assert.equal(persistedAuthorizedArtifact.provenance.jobId, artifactJob.id);
    await assert.rejects(repository.recordArtifactForActiveLease({
      workerId: 'asset-worker',
      jobId: artifactJob.id,
      ...authorizedArtifact,
      id: '9e108d27-0ff5-4ce6-a357-254b9dceab70',
      revision: 1,
      storageKey: 'integration/artifacts/stale.json',
    }), /lease/i);
    await prisma.$executeRaw`
      UPDATE "Job"
      SET "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
      WHERE "id" = ${artifactJob.id}
    `;
    await assert.rejects(repository.recordArtifactForActiveLease({
      workerId: 'asset-worker',
      jobId: artifactJob.id,
      ...authorizedArtifact,
      id: '05b2c914-e551-4529-8c02-760e31c6ab90',
      storageKey: 'integration/artifacts/expired.json',
    }), /lease/i);
    await prisma.$executeRaw`
      UPDATE "Job"
      SET "state" = 'done', "leaseOwner" = NULL, "leaseExpiresAt" = NULL
      WHERE "id" = ${artifactJob.id}
    `;
    const successfulArtifacts = await repository.listArtifactsForSuccessfulStageJobs(artifactRunId, 2);
    assert.deepEqual(successfulArtifacts.map((artifact) => artifact.id), [authorizedArtifact.id]);
    assert.equal(successfulArtifacts[0]?.action, 'produce_assets');
    assert.equal(successfulArtifacts[0]?.jobId, artifactJob.id);

    const auditRunId = '62c83c04-2c87-45fc-b3ef-95ed47c80aa5';
    await repository.createRun({
      id: auditRunId,
      title: 'Database audit artifact authorization',
      locale: 'en',
      brief: { source: 'audit-artifact-test' },
      currentStage: 'deliver',
      currentRevision: 2,
      packageChecksum: checksum,
      approvedChecksum: checksum,
      reviewStatus: 'approved',
      stages: [{ name: 'deliver', state: 'queued' }],
    });
    const auditJob = await repository.queueJob({
      runId: auditRunId,
      stage: 'deliver',
      action: 'deliver_package',
      idempotencyKey: 'integration-audit-artifact-job',
      input: {
        deliveryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        packageVersionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        packageChecksum: checksum,
      },
    });
    const auditClaim = await repository.claimJob({
      workerId: 'audit-worker',
      capabilities: ['deliver_package'],
      leaseSeconds: 120,
    });
    assert.equal(auditClaim?.jobId, auditJob.id);
    assert.equal(await repository.hasActiveArtifactLease({
      workerId: 'audit-worker',
      jobId: auditJob.id,
      runId: auditRunId,
      revision: 2,
      kind: 'raw_response',
    }), true);
    assert.equal(await repository.hasActiveArtifactLease({
      workerId: 'audit-worker',
      jobId: auditJob.id,
      runId: auditRunId,
      revision: 2,
      kind: 'execution_report',
    }), true);
    assert.equal(await repository.hasActiveArtifactLease({
      workerId: 'audit-worker',
      jobId: auditJob.id,
      runId: auditRunId,
      revision: 2,
      kind: 'generation.recipe.snapshot',
    }), true);
    const generationArtifact = await repository.recordArtifactForActiveLease({
      workerId: 'audit-worker',
      jobId: auditJob.id,
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      runId: auditRunId,
      revision: 2,
      kind: 'generation.execution.report',
      mediaType: 'application/json',
      checksum,
      storageKey: 'integration/artifacts/generation-execution-report.json',
      byteSize: 128,
      provenance: { provider: 'integration' },
      inputChecksum: checksum,
    });
    assert.equal(generationArtifact.kind, 'generation.execution.report');
    assert.equal(await repository.hasActiveArtifactLease({
      workerId: 'audit-worker',
      jobId: auditJob.id,
      runId: auditRunId,
      revision: 2,
      kind: 'evidence',
    }), false);

    const claims = await Promise.all([
      repository.claimJob({ workerId: 'worker-a', leaseSeconds: 120 }),
      repository.claimJob({ workerId: 'worker-b', leaseSeconds: 120 }),
    ]);
    const claim = claims.find((candidate) => candidate !== null);

    assert.ok(claim);
    assert.equal(claims.filter((candidate) => candidate !== null).length, 1);
    await assert.rejects(
      prisma.$executeRaw`UPDATE "Job" SET "leaseOwner" = ${'   '} WHERE "id" = ${claim!.jobId}`,
      /leaseOwner_nonempty|check constraint/i,
    );

    const constraints = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint WHERE conname = 'Job_leaseOwner_nonempty'
    `;
    assert.equal(constraints[0]?.conname, 'Job_leaseOwner_nonempty');

    const leaseBeforeHeartbeat = await prisma.job.findUniqueOrThrow({
      where: { id: claim!.jobId },
      select: { leaseExpiresAt: true },
    });
    await delay(100);
    await repository.renewJobLease({ jobId: claim!.jobId, workerId: claim!.claimedBy });
    const leaseAfterHeartbeat = await prisma.job.findUniqueOrThrow({
      where: { id: claim!.jobId },
      select: { leaseExpiresAt: true },
    });
    assert.ok(leaseAfterHeartbeat.leaseExpiresAt! > leaseBeforeHeartbeat.leaseExpiresAt!);
    await assert.rejects(
      repository.renewJobLease({ jobId: claim!.jobId, workerId: 'worker-not-owner' }),
      WorkflowConflictError,
    );

    await prisma.$executeRaw`
      UPDATE "Job"
      SET "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
      WHERE "id" = ${claim!.jobId}
    `;
    assert.equal(await repository.releaseExpiredLeases({ now: new Date() }), 1);
    assert.equal((await repository.getRun(runId))?.stages.research?.state, 'queued');

    const reclaimed = await repository.claimJob({
      workerId: 'worker-c',
      capabilities: ['collect_sources'],
      leaseSeconds: 120,
    });
    assert.equal(reclaimed?.jobId, claim!.jobId);
    const snapshot = await repository.recordArtifactForActiveLease({
      workerId: 'worker-c',
      jobId: reclaimed!.jobId,
      id: '55555555-5555-4555-8555-555555555555',
      runId,
      revision: 1,
      kind: 'source_snapshot',
      mediaType: 'text/plain',
      checksum: '5'.repeat(64),
      storageKey: 'integration/artifacts/source-snapshot.txt',
      byteSize: 64,
      provenance: { provider: 'integration-source-verifier', sourceId: '66666666-6666-4666-8666-666666666666' },
      inputChecksum: null,
    });
    assert.equal(snapshot.kind, 'source_snapshot');
    assert.equal(snapshot.action, 'collect_sources');
    const researchTransition = nextTransition({
      stage: 'research',
      state: 'running',
      revisionAttempts: 0,
      packageChecksum: null,
      approvedChecksum: null,
    }, { type: 'stage_completed', packageChecksum: checksum });
    const result = {
      jobId: reclaimed!.jobId,
      packageId: runId,
      stage: 'research' as const,
      state: 'done' as const,
      completedAt: '2026-07-12T12:00:00.000Z',
      outputChecksum: checksum,
      error: null,
    };
    const [first, replay] = await Promise.all([
      repository.applyJobResult({ workerId: 'worker-c', result, transition: researchTransition }),
      repository.applyJobResult({ workerId: 'worker-c', result, transition: researchTransition }),
    ]);
    assert.equal(first.currentStage, 'create');
    assert.deepEqual(replay, first);
    await assert.rejects(
      repository.applyJobResult({
        workerId: 'worker-c',
        result: { ...result, outputChecksum: 'b'.repeat(64) },
      }),
      WorkflowConflictError,
    );
    const queuedEffects = await prisma.workflowEffect.count({ where: { runId, type: 'queue_stage' } });
    assert.equal(queuedEffects, 1);

    const createClaim = await repository.claimJob({
      workerId: 'worker-c',
      capabilities: ['create_content'],
      leaseSeconds: 120,
    });
    const createTransition = nextTransition({
      stage: 'create',
      state: 'running',
      revisionAttempts: 0,
      packageChecksum: checksum,
      approvedChecksum: null,
    }, { type: 'stage_completed', packageChecksum: checksum });
    await repository.applyJobResult({
      workerId: 'worker-c',
      result: {
        jobId: createClaim!.jobId,
        packageId: runId,
        stage: 'create',
        state: 'done',
        completedAt: '2026-07-12T12:01:00.000Z',
        outputChecksum: checksum,
        error: null,
      },
      transition: createTransition,
    });
    const checkClaim = await repository.claimJob({
      workerId: 'worker-c',
      capabilities: ['check_content'],
      leaseSeconds: 120,
    });
    const checkTransition = nextTransition({
      stage: 'check',
      state: 'running',
      revisionAttempts: 0,
      packageChecksum: checksum,
      approvedChecksum: null,
    }, { type: 'stage_completed', packageChecksum: checksum });
    await repository.applyJobResult({
      workerId: 'worker-c',
      result: {
        jobId: checkClaim!.jobId,
        packageId: runId,
        stage: 'check',
        state: 'done',
        completedAt: '2026-07-12T12:02:00.000Z',
        outputChecksum: checksum,
        error: null,
      },
      transition: checkTransition,
    });
    const assetsClaim = await repository.claimJob({
      workerId: 'worker-c',
      capabilities: ['produce_assets'],
      leaseSeconds: 120,
    });
    const reviewed = await repository.applyJobResult({
      workerId: 'worker-c',
      result: {
        jobId: assetsClaim!.jobId,
        packageId: runId,
        stage: 'produce_assets',
        state: 'done',
        completedAt: '2026-07-12T12:02:30.000Z',
        outputChecksum: checksum,
        error: null,
      },
      transition: nextTransition({
        stage: 'produce_assets',
        state: 'running',
        revisionAttempts: 0,
        packageChecksum: checksum,
        approvedChecksum: null,
      }, { type: 'stage_completed', packageChecksum: checksum }),
    });
    assert.equal(reviewed.stages.human_review?.state, 'needs_human');
    assert.equal(await prisma.workflowEffect.count({ where: { runId, type: 'request_review' } }), 1);
    const approvedPackage = await repository.recordPackageVersion(packageVersionInput(runId, checksum));

    const approved = await repository.reviewRun({
      runId,
      packageChecksum: checksum,
      decision: 'approve',
      reviewerId: 'database-editor',
    });
    assert.equal(approved.currentStage, 'deliver');
    assert.equal(approved.reviewStatus, 'approved');
    assert.equal(approved.approvedChecksum, checksum);
    await repository.reviewRun({
      runId,
      packageChecksum: checksum,
      decision: 'approve',
      reviewerId: 'database-editor',
    });
    assert.equal(await prisma.review.count({ where: { runId, revision: 1, packageChecksum: checksum } }), 1);
    assert.equal(await prisma.job.count({ where: { runId, stage: 'deliver', state: 'queued' } }), 1);
    const approvedDelivery = await repository.getDeliveryForPackage(runId, checksum);
    assert.ok(approvedDelivery);
    assert.equal(approvedDelivery.packageVersionId, approvedPackage.id);
    const approvedClaim = await repository.claimJob({
      workerId: 'database-delivery-worker',
      capabilities: ['deliver_package'],
      leaseSeconds: 120,
    });
    assert.equal(approvedClaim?.deliveryId, approvedDelivery.id);
    assert.equal(approvedClaim?.packageVersionId, approvedPackage.id);
    assert.equal(approvedClaim?.packageChecksum, checksum);
    await repository.transitionDeliveryForActiveLease({
      id: approvedDelivery.id,
      jobId: approvedClaim!.jobId,
      workerId: 'database-delivery-worker',
      packageVersionId: approvedPackage.id,
      packageChecksum: checksum,
      expectedState: 'queued',
      state: 'running',
      incrementAttempts: true,
      nextAttemptAt: null,
    });
    await assert.rejects(repository.retryDelivery(approvedDelivery.id), /active.*lease/i);
    await prisma.job.update({
      where: { id: approvedClaim!.jobId },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    await repository.retryDelivery(approvedDelivery.id);
    const recoveredDeliveryClaim = await repository.claimJob({
      workerId: 'database-delivery-recovery-worker',
      capabilities: ['deliver_package'],
      leaseSeconds: 120,
    });
    assert.equal(recoveredDeliveryClaim?.jobId, approvedClaim!.jobId);
    const deliveryRetryAt = new Date(Date.now() + 60_000);
    await repository.transitionDeliveryForActiveLease({
      id: approvedDelivery.id,
      jobId: recoveredDeliveryClaim!.jobId,
      workerId: 'database-delivery-recovery-worker',
      packageVersionId: approvedPackage.id,
      packageChecksum: checksum,
      expectedState: 'running',
      state: 'waiting',
      response: { externalId: 'database-external-a' },
      nextAttemptAt: deliveryRetryAt,
    });
    await repository.applyJobResult({
      workerId: 'database-delivery-recovery-worker',
      result: {
        jobId: recoveredDeliveryClaim!.jobId,
        packageId: runId,
        stage: 'deliver',
        state: 'waiting',
        completedAt: '2026-07-13T10:00:00.000Z',
        outputChecksum: null,
        error: 'verification_failed',
      },
      transition: nextTransition({
        stage: 'deliver',
        state: 'running',
        revisionAttempts: 0,
        packageChecksum: checksum,
        approvedChecksum: checksum,
      }, { type: 'job_waiting', reason: 'verification_failed' }),
      retryAt: deliveryRetryAt,
    });

    const staleClaim = await repository.claimJob({
      workerId: 'database-stale-delivery-worker',
      capabilities: ['deliver_package'],
      leaseSeconds: 120,
      now: deliveryRetryAt,
    });
    assert.ok(staleClaim);
    await repository.transitionDeliveryForActiveLease({
      id: approvedDelivery.id,
      jobId: staleClaim.jobId,
      workerId: 'database-stale-delivery-worker',
      packageVersionId: approvedPackage.id,
      packageChecksum: checksum,
      expectedState: 'waiting',
      state: 'running',
      incrementAttempts: true,
      nextAttemptAt: null,
      now: deliveryRetryAt,
    });

    await repository.recordPackageVersion(packageVersionInput(runId, changedChecksum));
    const invalidated = await repository.getRun(runId);
    assert.ok(invalidated);
    assert.equal(invalidated.currentStage, 'human_review');
    assert.equal(invalidated.reviewStatus, 'pending');
    assert.equal(invalidated.approvedChecksum, null);
    assert.equal((await repository.getDelivery(approvedDelivery.id))?.state, 'superseded');
    await assert.rejects(repository.transitionDeliveryForActiveLease({
      id: approvedDelivery.id,
      jobId: staleClaim.jobId,
      workerId: 'database-stale-delivery-worker',
      packageVersionId: approvedPackage.id,
      packageChecksum: checksum,
      expectedState: 'running',
      state: 'succeeded',
      response: { externalId: 'database-external-a', verification: { matches: true } },
      nextAttemptAt: null,
    }), /transition fence/i);
    const staleDelivery = await repository.getDelivery(approvedDelivery.id);
    assert.equal(staleDelivery?.state, 'superseded');
    assert.equal((staleDelivery?.response?.verification as { matches?: boolean } | undefined)?.matches, true);
    assert.equal((staleDelivery?.response?.lateEvidence as unknown[] | undefined)?.length, 1);

    const retryRunId = 'c0a8012e-7b5d-4e73-95e3-4873b519b38c';
    await repository.createRun({
      id: retryRunId,
      title: 'Database retry integration',
      locale: 'en',
      brief: { source: 'retry-test' },
    });
    const retryJob = await repository.queueJob({
      runId: retryRunId,
      stage: 'research',
      action: 'collect_sources',
      idempotencyKey: 'integration-retry-job',
      input: { query: 'retry integration' },
    });
    await repository.claimJob({ workerId: 'retry-worker', capabilities: ['collect_sources'], leaseSeconds: 120 });
    const retryAt = new Date(Date.now() + 600);
    const waitingResult = {
      jobId: retryJob.id,
      packageId: retryRunId,
      stage: 'research' as const,
      state: 'waiting' as const,
      completedAt: '2026-07-12T12:03:00.000Z',
      outputChecksum: null,
      error: 'provider_cooldown',
    };
    const waitingTransition = nextTransition({
      stage: 'research',
      state: 'running',
      revisionAttempts: 0,
      packageChecksum: null,
      approvedChecksum: null,
    }, { type: 'job_waiting', reason: 'provider_cooldown' });
    const waiting = await repository.applyJobResult({
      workerId: 'retry-worker',
      result: waitingResult,
      retryAt,
      transition: waitingTransition,
    });
    assert.equal(waiting.nextRetryAt?.toISOString(), retryAt.toISOString());
    await delay(750);
    assert.deepEqual(await repository.applyJobResult({
      workerId: 'retry-worker',
      result: waitingResult,
      retryAt,
    }), waiting);

    const checkRetryRunId = 'e2b7a192-6f0d-42c4-8611-cf079ed5a2b3';
    await repository.createRun({
      id: checkRetryRunId,
      title: 'Database check retry independence',
      locale: 'en',
      brief: { source: 'check-retry-test' },
      currentStage: 'check',
      stages: [
        { name: 'create', state: 'queued' },
        { name: 'check', state: 'queued' },
      ],
    });
    const checkRetryJob = await repository.queueJob({
      runId: checkRetryRunId,
      stage: 'check',
      action: 'check_content',
      idempotencyKey: 'integration-check-retry-job',
      input: { brief: 'check retry independence' },
    });
    await repository.claimJob({ workerId: 'check-worker', capabilities: ['check_content'], leaseSeconds: 120 });
    await prisma.$executeRaw`
      UPDATE "Job"
      SET "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
      WHERE "id" = ${checkRetryJob.id}
    `;
    assert.equal(await repository.releaseExpiredLeases({ now: new Date() }), 1);
    const reclaimedCheck = await repository.claimJob({
      workerId: 'check-worker',
      capabilities: ['check_content'],
      leaseSeconds: 120,
    });
    assert.equal(reclaimedCheck?.jobId, checkRetryJob.id);
    assert.equal(reclaimedCheck?.attempt, 2);
    const checkContext = await repository.getJobContext(checkRetryJob.id);
    assert.equal(checkContext?.stage.revisionAttempts, 0);
    const qualityFailure = nextTransition({
      stage: 'check',
      state: 'running',
      revisionAttempts: checkContext!.stage.revisionAttempts,
      packageChecksum: null,
      approvedChecksum: null,
    }, { type: 'quality_failed', reason: 'missing citations' });
    const qualityRetry = await repository.applyJobResult({
      workerId: 'check-worker',
      result: {
        jobId: checkRetryJob.id,
        packageId: checkRetryRunId,
        stage: 'check',
        state: 'needs_human',
        completedAt: '2026-07-12T12:03:30.000Z',
        outputChecksum: null,
        error: 'missing citations',
      },
      transition: qualityFailure,
    });
    assert.equal(qualityRetry.currentStage, 'create');
    assert.equal(qualityRetry.stages.create?.revisionAttempts, 1);

    const invalidRetryRunId = '307fee2c-6ea4-4ccc-9d02-75f8b3cc10b0';
    await repository.createRun({
      id: invalidRetryRunId,
      title: 'Database invalid retry time',
      locale: 'en',
      brief: { source: 'invalid-retry-test' },
    });
    const invalidRetryJob = await repository.queueJob({
      runId: invalidRetryRunId,
      stage: 'research',
      action: 'collect_sources',
      idempotencyKey: 'integration-invalid-retry-job',
      input: { query: 'invalid retry integration' },
    });
    await repository.claimJob({ workerId: 'invalid-retry-worker', capabilities: ['collect_sources'], leaseSeconds: 120 });
    await assert.rejects(repository.applyJobResult({
      workerId: 'invalid-retry-worker',
      result: {
        jobId: invalidRetryJob.id,
        packageId: invalidRetryRunId,
        stage: 'research',
        state: 'waiting',
        completedAt: '2026-07-12T12:04:00.000Z',
        outputChecksum: null,
        error: 'provider_cooldown',
      },
      retryAt: new Date(Date.now() - 1),
      transition: nextTransition({
        stage: 'research',
        state: 'running',
        revisionAttempts: 0,
        packageChecksum: null,
        approvedChecksum: null,
      }, { type: 'job_waiting', reason: 'provider_cooldown' }),
    }), /retry.*future/i);

    const deliveryRunId = '7b5d4e73-95e3-4873-b519-c0a8012e7b5d';
    await repository.createRun({
      id: deliveryRunId,
      title: 'Database delivery integration',
      locale: 'en',
      brief: { source: 'delivery-test' },
      currentStage: 'deliver',
      packageChecksum: checksum,
      approvedChecksum: checksum,
      reviewStatus: 'approved',
      stages: [{ name: 'deliver', state: 'queued' }],
    });
    const deliveryJob = await repository.queueJob({
      runId: deliveryRunId,
      stage: 'deliver',
      action: 'deliver_package',
      idempotencyKey: 'integration-delivery-job',
      input: {
        deliveryId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        packageVersionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        packageChecksum: checksum,
      },
    });
    await repository.claimJob({ workerId: 'delivery-worker', capabilities: ['deliver_package'], leaseSeconds: 120 });
    const delivered = await repository.applyJobResult({
      workerId: 'delivery-worker',
      result: {
        jobId: deliveryJob.id,
        packageId: deliveryRunId,
        stage: 'deliver',
        state: 'done',
        completedAt: '2026-07-12T12:04:00.000Z',
        outputChecksum: checksum,
        error: null,
      },
      transition: nextTransition({
        stage: 'deliver',
        state: 'running',
        revisionAttempts: 0,
        packageChecksum: checksum,
        approvedChecksum: checksum,
      }, { type: 'delivery_succeeded' }),
    });
    assert.equal(delivered.stages.deliver?.state, 'done');
    assert.equal(await prisma.workflowEffect.count({ where: { runId: deliveryRunId, type: 'record_delivery' } }), 1);

    const concurrentRunId = '6c2ea1a2-2d0f-43dc-9ea4-ef56f78dd221';
    await repository.createRun({
      id: concurrentRunId,
      title: 'Concurrent package replacement',
      locale: 'en',
      brief: {},
      currentStage: 'human_review',
      packageChecksum: checksum,
      stages: [{ name: 'human_review', state: 'needs_human' }],
    });
    await repository.recordPackageVersion(packageVersionInput(concurrentRunId, checksum));

    await Promise.allSettled([
      repository.reviewRun({
        runId: concurrentRunId,
        packageChecksum: checksum,
        decision: 'approve',
        reviewerId: 'database-editor',
      }),
      repository.recordPackageVersion(packageVersionInput(concurrentRunId, changedChecksum)),
    ]);

    const concurrent = await repository.getRun(concurrentRunId);
    assert.equal(concurrent?.packageChecksum, changedChecksum);
    assert.equal(concurrent?.approvedChecksum, null);
    assert.equal(concurrent?.currentStage, 'human_review');
    assert.equal(await prisma.job.count({
      where: {
        runId: concurrentRunId,
        stage: 'deliver',
        state: { in: ['queued', 'running'] },
      },
    }), 0);

    const replayRunId = '7270fb64-8ba4-4b03-a2c4-bad2c3e62f52';
    await repository.createRun({
      id: replayRunId,
      title: 'PostgreSQL review replay',
      locale: 'en',
      brief: {},
      currentStage: 'human_review',
      packageChecksum: checksum,
      stages: [{ name: 'human_review', state: 'needs_human' }],
    });
    await repository.recordPackageVersion(packageVersionInput(replayRunId, checksum));
    const decision = {
      runId: replayRunId,
      packageChecksum: checksum,
      decision: 'request_changes' as const,
      reviewerId: 'database-editor',
      comment: 'Clarify the source.',
    };
    assert.equal((await repository.reviewRun(decision)).currentRevision, 2);
    assert.equal((await repository.reviewRun(decision)).currentRevision, 2);
    await assert.rejects(repository.reviewRun({ ...decision, comment: 'Use another source.' }), /conflict/i);
  },
);

test(
  'review package migration consolidates exact duplicates and rejects conflicting historical decisions',
  { skip: dockerUnavailable ? 'Docker is unavailable' : false, timeout: 120_000 },
  async (t) => {
    const containerName = `knowledge-bits-migration-test-${randomUUID()}`;
    await startPostgres(containerName, 'duplicate_reviews');
    t.after(() => removeContainer(containerName));

    await createDatabase(containerName, 'conflicting_reviews');
    const baseline = [
      '20260712183522_init',
      '20260712200000_harden_workflow_leases',
      '20260712213000_harden_result_idempotency',
      '20260713100000_add_review_state',
    ].map(readMigration).join('\n');
    const finalMigration = readMigration('20260713130000_bind_reviews_to_packages');

    applySql(containerName, 'duplicate_reviews', baseline);
    applySql(containerName, 'duplicate_reviews', historicalReviewSql('approve', 'approve'));
    applySql(containerName, 'duplicate_reviews', finalMigration);
    assert.equal(querySql(containerName, 'duplicate_reviews', 'SELECT count(*) FROM "Review";'), '1');

    applySql(containerName, 'conflicting_reviews', baseline);
    applySql(containerName, 'conflicting_reviews', historicalReviewSql('approve', 'request_changes'));
    const conflict = applySql(containerName, 'conflicting_reviews', finalMigration, false);
    assert.notEqual(conflict.status, 0);
    assert.match(`${conflict.stdout}\n${conflict.stderr}`, /Conflicting historical reviews for the same immutable package/);
  },
);

test(
  'delivery migration consolidates equivalent duplicates and rejects conflicts and ambiguous package matches',
  { skip: dockerUnavailable ? 'Docker is unavailable' : false, timeout: 120_000 },
  async (t) => {
    const containerName = `knowledge-bits-delivery-migration-test-${randomUUID()}`;
    await startPostgres(containerName, 'equivalent_deliveries');
    t.after(() => removeContainer(containerName));
    await createDatabase(containerName, 'conflicting_deliveries');
    await createDatabase(containerName, 'ambiguous_deliveries');
    const baseline = [
      '20260712183522_init',
      '20260712200000_harden_workflow_leases',
      '20260712213000_harden_result_idempotency',
      '20260713100000_add_review_state',
      '20260713130000_bind_reviews_to_packages',
    ].map(readMigration).join('\n');
    const deliveryMigration = readMigration('20260713160000_add_delivery_control');

    applySql(containerName, 'equivalent_deliveries', baseline);
    applySql(containerName, 'equivalent_deliveries', historicalDeliverySql({ duplicateState: 'waiting' }));
    applySql(containerName, 'equivalent_deliveries', deliveryMigration);
    assert.equal(querySql(containerName, 'equivalent_deliveries', 'SELECT count(*) FROM "Delivery";'), '1');
    assert.equal(querySql(containerName, 'equivalent_deliveries', 'SELECT "id" FROM "Delivery";'), 'delivery-1');
    assert.equal(querySql(containerName, 'equivalent_deliveries', 'SELECT "packageVersionId" FROM "Delivery";'), 'package-version-1');

    applySql(containerName, 'conflicting_deliveries', baseline);
    applySql(containerName, 'conflicting_deliveries', historicalDeliverySql({ duplicateState: 'failed' }));
    const conflict = applySql(containerName, 'conflicting_deliveries', deliveryMigration, false);
    assert.notEqual(conflict.status, 0);
    assert.match(`${conflict.stdout}\n${conflict.stderr}`, /Conflicting historical deliveries for the same immutable package/);

    applySql(containerName, 'ambiguous_deliveries', baseline);
    applySql(containerName, 'ambiguous_deliveries', historicalDeliverySql({ duplicateState: null, ambiguousPackage: true }));
    const ambiguous = applySql(containerName, 'ambiguous_deliveries', deliveryMigration, false);
    assert.notEqual(ambiguous.status, 0);
    assert.match(`${ambiguous.stdout}\n${ambiguous.stderr}`, /Ambiguous historical delivery package version match/);
  },
);

test(
  'Prisma prepares a guarded legacy revision without replacing immutable history',
  { skip: dockerUnavailable ? 'Docker is unavailable; Prisma legacy revision proof requires OrbStack' : false, timeout: 120_000 },
  async (t) => {
    const containerName = `knowledge-bits-legacy-revision-${randomUUID()}`;
    const databaseName = 'knowledge_bits_legacy_revision_test';
    const databaseUrl = await startPostgres(containerName, databaseName);
    t.after(() => removeContainer(containerName));
    await deployMigrations(databaseUrl);
    const runtimeDatabaseUrl = createRestrictedRuntimeLogin(containerName, databaseName, databaseUrl);
    const prisma = createIsolatedPrismaClient({ ENGINE_DATABASE_URL: runtimeDatabaseUrl });
    t.after(() => prisma.$disconnect());
    const repository = createWorkflowRepository(prisma);
    const runId = randomUUID();
    const legacyPackage = strictPackageVersionInput(runId, 'legacy');
    await repository.createRun({
      id: runId,
      title: 'Prisma legacy revision',
      locale: 'en',
      brief: { objective: 'Historical unreadable package', notebookLmNotebookId: 'notebook-fixture' },
      notebookLmNotebookId: 'notebook-fixture',
      currentStage: 'human_review',
      packageChecksum: legacyPackage.packageChecksum,
      stages: [{ name: 'human_review', state: 'needs_human' }],
    });
    const immutable = await repository.recordPackageVersion(legacyPackage);
    const oldJob = await repository.queueJob({
      runId,
      stage: 'create',
      action: 'create_content',
      idempotencyKey: `legacy-old:${runId}`,
      input: { brief: { objective: 'old' } },
    });
    await repository.claimJob({ workerId: 'legacy-worker', capabilities: ['create_content'], leaseSeconds: 60 });
    const input = {
      runId,
      expectedRevision: 1,
      expectedPackageChecksum: legacyPackage.packageChecksum,
      notebookLmNotebookId: 'notebook-fixture',
      brief: strictLegacyReplacementBrief(),
      comment: 'Replace the unreadable legacy package with the validated baseline.',
      operatorId: 'editor-1',
    };
    const prepared = await repository.prepareLegacyRevision(input);
    const replay = await repository.prepareLegacyRevision(input);

    assert.equal(prepared.run.currentRevision, 2);
    assert.equal(prepared.run.notebookLmNotebookId, 'notebook-fixture');
    assert.equal((await repository.getPackageVersion(runId, legacyPackage.packageChecksum))?.id, immutable.id);
    assert.deepEqual(replay, prepared);
    const persistedOldJob = await prisma.job.findUnique({ where: { id: oldJob.id } });
    assert.equal(persistedOldJob?.state, 'superseded');
    assert.equal(persistedOldJob?.leaseOwner, null);
    assert.equal(persistedOldJob?.leaseExpiresAt, null);
    assert.equal(persistedOldJob?.executionDeadlineAt, null);
    assert.equal(await prisma.job.count({ where: { runId, stage: 'research', state: 'queued' } }), 1);
    assert.equal(await prisma.job.count({ where: { runId, stage: 'human_review', state: 'queued' } }), 0);
    const effect = await prisma.workflowEffect.findFirst({ where: { runId, type: 'prepare_legacy_revision' } });
    assert.ok(effect);
    assert.equal((effect.payload as { newRevision?: unknown }).newRevision, 2);
    const serializedEffect = JSON.stringify(effect.payload);
    assert.match(serializedEffect, /editor-1/);
    assert.doesNotMatch(serializedEffect, /bytesBase64|Generate infographic-artifact/);
    await assert.rejects(repository.prepareLegacyRevision({ ...input, expectedRevision: 2 }), /expected (revision|package checksum)/i);
    await assert.rejects(repository.prepareLegacyRevision({ ...input, comment: 'Different comment.' }), /existing operation/i);
  },
);

const checksum = strictPackageVersionInput('00000000-0000-4000-8000-000000000001', 'A').packageChecksum;
const changedChecksum = strictPackageVersionInput('00000000-0000-4000-8000-000000000001', 'B').packageChecksum;

function packageVersionInput(runId: string, packageChecksum: string) {
  return strictPackageVersionInput(runId, packageChecksum === changedChecksum ? 'B' : 'A');
}

function readMigration(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../prisma/migrations/${name}/migration.sql`, import.meta.url)), 'utf8');
}

function historicalReviewSql(firstDecision: string, secondDecision: string): string {
  return `
    INSERT INTO "Run" (
      "id", "title", "locale", "brief", "currentStage", "currentRevision", "reviewStatus", "createdAt", "updatedAt"
    ) VALUES (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Historical review', 'en', '{}'::jsonb,
      'human_review', 2, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "Review" (
      "id", "runId", "revision", "packageChecksum", "decision", "reviewerId", "comment", "createdAt"
    ) VALUES
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, '${checksum}', '${firstDecision}', 'reviewer-1', NULL, CURRENT_TIMESTAMP),
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2, '${checksum}', '${secondDecision}', 'reviewer-1', NULL, CURRENT_TIMESTAMP + INTERVAL '1 second');
  `;
}

function historicalDeliverySql(options: { duplicateState: string | null; ambiguousPackage?: boolean }): string {
  return `
    INSERT INTO "Run" (
      "id", "title", "locale", "brief", "currentStage", "currentRevision", "reviewStatus", "createdAt", "updatedAt"
    ) VALUES (
      'delivery-run', 'Historical delivery', 'en', '{}'::jsonb,
      'deliver', 2, 'approved', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "PackageVersion" (
      "id", "runId", "revision", "packageChecksum", "adapterVersion", "locale", "owner",
      "usageRights", "content", "evidence", "qa", "artifactInventory", "createdAt"
    ) VALUES
      ('package-version-1', 'delivery-run', 1, '${checksum}', 'review-package@1', 'en', 'engine',
       '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, CURRENT_TIMESTAMP)
      ${options.ambiguousPackage ? `,
      ('package-version-2', 'delivery-run', 2, '${checksum}', 'review-package@1', 'en', 'engine',
       '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, CURRENT_TIMESTAMP + INTERVAL '1 second')` : ''};
    INSERT INTO "Delivery" (
      "id", "runId", "target", "packageChecksum", "idempotencyKey", "state", "attempts",
      "response", "nextAttemptAt", "createdAt", "updatedAt"
    ) VALUES
      ('delivery-1', 'delivery-run', 'nuglet.lesson.v1', '${checksum}', 'external-key-1', 'waiting', 1,
       '{"externalId":"existing"}'::jsonb, TIMESTAMP '2026-07-13 12:00:00',
       TIMESTAMP '2026-07-13 10:00:00', TIMESTAMP '2026-07-13 11:00:00')
      ${options.duplicateState ? `,
      ('delivery-2', 'delivery-run', 'nuglet.lesson.v1', '${checksum}', 'external-key-2', '${options.duplicateState}', 1,
       '{"externalId":"existing"}'::jsonb, TIMESTAMP '2026-07-13 12:00:00',
       TIMESTAMP '2026-07-13 10:05:00', TIMESTAMP '2026-07-13 11:05:00')` : ''};
  `;
}

async function createDatabase(containerName: string, databaseName: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      run('docker', ['exec', containerName, 'createdb', '-U', 'postgres', databaseName]);
      return;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw lastError;
}

function applySql(containerName: string, databaseName: string, sql: string, requireSuccess = true) {
  const result = spawnSync('docker', [
    'exec', '-i', containerName, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', databaseName,
  ], { input: sql, encoding: 'utf8', timeout: 30_000 });
  if (requireSuccess && result.status !== 0) {
    throw new Error(`Could not apply PostgreSQL test SQL: ${result.stderr || result.stdout}`);
  }
  return result;
}

function querySql(containerName: string, databaseName: string, sql: string): string {
  return run('docker', ['exec', containerName, 'psql', '-tA', '-U', 'postgres', '-d', databaseName, '-c', sql]);
}

async function startPostgres(containerName: string, databaseName: string): Promise<string> {
  run('docker', [
    'run',
    '--detach',
    '--rm',
    '--name',
    containerName,
    '--env',
    'POSTGRES_USER=postgres',
    '--env',
    'POSTGRES_PASSWORD=postgres',
    '--env',
    `POSTGRES_DB=${databaseName}`,
    '--publish',
    '127.0.0.1::5432',
    'postgres:16-alpine',
  ]);

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const ready = spawnSync('docker', ['exec', containerName, 'pg_isready', '-U', 'postgres', '-d', databaseName], {
      stdio: 'ignore',
      timeout: 10_000,
    }).status === 0;
    if (ready) {
      // Do not mistake the image entrypoint's temporary initialization server for the final postmaster.
      await delay(750);
      const stable = spawnSync('docker', ['exec', containerName, 'pg_isready', '-U', 'postgres', '-d', databaseName], {
        stdio: 'ignore',
        timeout: 10_000,
      }).status === 0;
      if (!stable) continue;
      const published = run('docker', ['port', containerName, '5432/tcp']);
      const port = published.match(/:(\d+)\s*$/m)?.[1];
      if (!port) throw new Error(`Could not resolve PostgreSQL port: ${published}`);
      return `postgresql://postgres:postgres@127.0.0.1:${port}/${databaseName}?schema=public`;
    }
    await delay(250);
  }

  throw new Error('Local PostgreSQL test container did not become ready');
}

async function deployMigrations(databaseUrl: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
        cwd: apiRoot,
        env: {
          ...process.env,
          DATABASE_URL: '',
          ENGINE_DATABASE_URL: databaseUrl,
          ENGINE_MIGRATION_DATABASE_URL: databaseUrl,
        },
      });
      return;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw lastError;
}

function createRestrictedRuntimeLogin(containerName: string, databaseName: string, ownerUrl: string): string {
  applySql(containerName, databaseName, `
    CREATE ROLE knowledge_bits_runtime_login LOGIN PASSWORD 'runtime-test-password';
    GRANT knowledge_bits_runtime TO knowledge_bits_runtime_login;
  `);
  const runtimeUrl = new URL(ownerUrl);
  runtimeUrl.username = 'knowledge_bits_runtime_login';
  runtimeUrl.password = 'runtime-test-password';
  return runtimeUrl.toString();
}

function removeContainer(containerName: string): void {
  spawnSync('docker', ['rm', '--force', containerName], { stdio: 'ignore', timeout: 30_000 });
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync(command, args, {
    ...options,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 60_000,
  }).trim();
}
