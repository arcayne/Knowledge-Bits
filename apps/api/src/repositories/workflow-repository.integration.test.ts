import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import test from 'node:test';

import { nextTransition } from '@knowledge-bits/pipeline';

import { createIsolatedPrismaClient } from '../config.js';
import {
  createWorkflowRepository,
  WorkflowConflictError,
} from './workflow-repository.js';

const apiRoot = fileURLToPath(new URL('../../', import.meta.url));
const dockerUnavailable = spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0;

test(
  'local PostgreSQL migration preserves bootstrap, effects, leases, retries, and idempotent results',
  { skip: dockerUnavailable ? 'Docker is unavailable; migration SQL contract test still runs' : false, timeout: 120_000 },
  async (t) => {
    const containerName = `knowledge-bits-api-test-${randomUUID()}`;
    const databaseName = 'knowledge_bits_test';
    const databaseUrl = await startPostgres(containerName, databaseName);
    t.after(() => removeContainer(containerName));

    await deployMigrations(databaseUrl);

    const prisma = createIsolatedPrismaClient({ ENGINE_DATABASE_URL: databaseUrl });
    t.after(() => prisma.$disconnect());
    const repository = createWorkflowRepository(prisma);
    const runId = '0f8fad5b-d9cb-469f-a165-70867728950e';

    const bootstrapped = await repository.bootstrapRun({
      id: runId,
      title: 'Database workflow integration',
      locale: 'en',
      brief: { source: 'integration-test' },
    });
    assert.equal(bootstrapped.stages.human_review, undefined);

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
      stages: [{ name: 'deliver', state: 'queued' }],
    });
    const deliveryJob = await repository.queueJob({
      runId: deliveryRunId,
      stage: 'deliver',
      action: 'deliver_package',
      idempotencyKey: 'integration-delivery-job',
      input: { packageChecksum: checksum },
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
  },
);

const checksum = 'a'.repeat(64);

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
    if (spawnSync('docker', ['exec', containerName, 'pg_isready', '-U', 'postgres', '-d', databaseName], {
      stdio: 'ignore',
    }).status === 0) {
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

function removeContainer(containerName: string): void {
  spawnSync('docker', ['rm', '--force', containerName], { stdio: 'ignore' });
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync(command, args, {
    ...options,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}
