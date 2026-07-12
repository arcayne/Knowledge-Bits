import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import test from 'node:test';

import { createIsolatedPrismaClient } from '../config.js';
import {
  createWorkflowRepository,
  WorkflowConflictError,
} from './workflow-repository.js';

const apiRoot = fileURLToPath(new URL('../../', import.meta.url));
const dockerUnavailable = spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0;

test(
  'local PostgreSQL migration atomically claims jobs and validates leases with the database clock',
  { skip: dockerUnavailable ? 'Docker is unavailable; migration SQL contract test still runs' : false, timeout: 120_000 },
  async (t) => {
    const containerName = `knowledge-bits-api-test-${randomUUID()}`;
    const databaseName = 'knowledge_bits_test';
    const databaseUrl = await startPostgres(containerName, databaseName);
    t.after(() => removeContainer(containerName));

    run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: apiRoot,
      env: {
        ...process.env,
        DATABASE_URL: '',
        ENGINE_DATABASE_URL: databaseUrl,
      },
    });

    const prisma = createIsolatedPrismaClient({ ENGINE_DATABASE_URL: databaseUrl });
    t.after(() => prisma.$disconnect());
    const repository = createWorkflowRepository(prisma);
    const runId = '0f8fad5b-d9cb-469f-a165-70867728950e';

    await repository.createRun({
      id: runId,
      title: 'Database lease integration',
      locale: 'en',
      brief: { source: 'integration-test' },
      currentStage: 'research',
    });
    const queuedJob = await repository.queueJob({
      runId,
      stage: 'research',
      action: 'collect_sources',
      idempotencyKey: 'integration-claim-job',
      input: { query: 'lease integration' },
    });

    const claims = await Promise.all([
      repository.claimJob({ workerId: 'worker-a', leaseSeconds: 120 }),
      repository.claimJob({ workerId: 'worker-b', leaseSeconds: 120 }),
    ]);
    const claim = claims.find((candidate) => candidate !== null);

    assert.equal(claim?.jobId, queuedJob.id);
    assert.equal(claims.filter((candidate) => candidate !== null).length, 1);
    await assert.rejects(
      prisma.$executeRaw`UPDATE "Job" SET "leaseOwner" = ${'   '} WHERE "id" = ${queuedJob.id}`,
      /leaseOwner_nonempty|check constraint/i,
    );

    const constraints = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint WHERE conname = 'Job_leaseOwner_nonempty'
    `;
    assert.equal(constraints[0]?.conname, 'Job_leaseOwner_nonempty');

    await prisma.$executeRaw`
      UPDATE "Job"
      SET "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
      WHERE "id" = ${queuedJob.id}
    `;
    await assert.rejects(
      repository.completeJob({
        workerId: claim!.claimedBy,
        result: {
          jobId: queuedJob.id,
          packageId: runId,
          stage: 'research',
          state: 'done',
          completedAt: '2000-01-01T00:00:00.000Z',
          outputChecksum: null,
          error: null,
        },
      }),
      WorkflowConflictError,
    );
  },
);

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
