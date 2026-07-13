import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import test from 'node:test';

import { createApp } from '../../apps/api/dist/app.js';
import { createIsolatedPrismaClient } from '../../apps/api/dist/config.js';
import { createWorkflowRepository } from '../../apps/api/dist/repositories/workflow-repository.js';
import { FixtureDeliveryAdapter } from '../../apps/api/dist/services/delivery-adapters/fixture.js';
import { HttpEngineClient } from '../../apps/worker/dist/engine-client.js';
import { WorkerExecutor } from '../../apps/worker/dist/executor.js';
import { composeWorkerProviders } from '../../apps/worker/dist/runtime.js';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const apiRoot = fileURLToPath(new URL('../../apps/api/', import.meta.url));
const fixtureRoot = fileURLToPath(new URL('../fixtures/attention-recovery/', import.meta.url));
const providerRoot = fileURLToPath(new URL('../fixtures/attention-recovery/providers/', import.meta.url));
const dockerUnavailable = spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0;

test(
  'brief becomes one approved and verified Knowledge Bits delivery',
  { skip: dockerUnavailable ? 'Docker is unavailable' : false, timeout: 120_000 },
  async (t) => {
    const containerName = `knowledge-bits-e2e-${randomUUID()}`;
    const databaseUrl = await startPostgres(containerName);
    t.after(() => removeContainer(containerName));
    await deployMigrations(databaseUrl);

    const prisma = createIsolatedPrismaClient({ ENGINE_DATABASE_URL: databaseUrl });
    t.after(() => prisma.$disconnect());
    const repository = createWorkflowRepository(prisma);
    const storage = new FixtureStorageAdapter();
    const deliveryAdapter = new FixtureDeliveryAdapter();
    const app = createApp({
      repository,
      artifactStorage: storage,
      deliveryAdapter,
      env: {
        ENGINE_API_TOKEN: 'fixture-api-token',
        ENGINE_REVIEW_TOKEN: 'fixture-review-token',
        ENGINE_REVIEWER_ID: 'fixture-editor',
        ENGINE_WORKER_CREDENTIALS: JSON.stringify([
          workerCredential('fixture-worker-before-restart', 'fixture-worker-token-a'),
          workerCredential('fixture-worker-after-restart', 'fixture-worker-token-b'),
        ]),
      },
    });
    const routedFetch = createRoutedFetch(app, storage);
    const providers = composeWorkerProviders({
      env: {
        WORKER_PROVIDER_MODE: 'fixture',
        WORKER_FIXTURE_DIRECTORY: providerRoot,
      },
    });
    const firstClient = new HttpEngineClient({
      baseUrl: 'https://engine.example.test',
      workerToken: 'fixture-worker-token-a',
      fetch: routedFetch,
    });
    const restartedClient = new HttpEngineClient({
      baseUrl: 'https://engine.example.test',
      workerToken: 'fixture-worker-token-b',
      fetch: routedFetch,
    });
    const fixtureBrief = JSON.parse(await readFile(`${fixtureRoot}/brief.json`, 'utf8'));
    const fixtureCandidate = JSON.parse(await readFile(`${providerRoot}/create-content.json`, 'utf8'));

    const created = await requestJson(app, '/runs', 'fixture-api-token', {
      method: 'POST',
      body: fixtureBrief,
      expectedStatus: 201,
    });
    await drainFixtureWorker(firstClient, providers, 2);

    const interrupted = await firstClient.claim(1);
    assert.ok(interrupted, 'the pre-restart worker should hold the check job');
    assert.equal(interrupted.stage, 'check');
    await prisma.job.update({
      where: { id: interrupted.jobId },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    assert.equal(await repository.releaseExpiredLeases(), 1);

    await drainFixtureWorker(restartedClient, providers);
    const reclaimed = await prisma.job.findUniqueOrThrow({ where: { id: interrupted.jobId } });
    assert.equal(reclaimed.state, 'done');
    assert.equal(reclaimed.attempt, 2);

    const review = await requestJson(app, `/runs/${created.id}/review`, 'fixture-review-token');
    assert.equal(review.currentStage, 'human_review');
    assert.equal(review.decisionAllowed, true);
    assert.deepEqual(review.issues, []);
    assert.ok(review.package);
    assert.equal(review.currentPackageChecksum, review.package.packageChecksum);
    assert.equal(review.package.evidence.sources.length, 2);
    assert.ok(review.package.evidence.sources.every(({ url }) => new URL(url).hostname === 'example.test'));
    assert.ok(review.package.evidence.claims.every(({ citations }) => citations.length > 0));
    assert.ok(review.package.content.target.payload.claims.every(({ citations }) => citations.length > 0));
    assert.deepEqual(review.package.content.target.payload, fixtureCandidate);
    const contentChecksum = createHash('sha256')
      .update(JSON.stringify(fixtureCandidate))
      .digest('hex');
    assert.equal(review.package.qa.deterministic.contentChecksum, contentChecksum);
    assert.ok(review.package.artifactInventory
      .filter(({ kind }) => ['hero', 'infographic', 'audio'].includes(kind))
      .every(({ inputChecksum }) => inputChecksum === contentChecksum));
    assert.deepEqual(
      Object.values(review.assets).map(({ state }) => state),
      ['available', 'available', 'available'],
    );

    const approval = await requestJson(app, `/runs/${created.id}/review`, 'fixture-review-token', {
      method: 'POST',
      body: { decision: 'approve', packageChecksum: review.package.packageChecksum },
    });
    assert.equal(approval.approvedChecksum, review.package.packageChecksum);
    assert.equal(await prisma.review.count({ where: { runId: created.id } }), 1);
    assert.equal(await prisma.job.count({ where: { runId: created.id, stage: 'deliver' } }), 1);

    deliveryAdapter.verifyMatches = false;
    await drainFixtureWorker(restartedClient, providers);
    const firstDelivery = await repository.getDeliveryForPackage(created.id, review.package.packageChecksum);
    assert.equal(firstDelivery?.state, 'failed');

    deliveryAdapter.verifyMatches = true;
    await requestJson(app, `/deliveries/${firstDelivery.id}/retry`, 'fixture-review-token', { method: 'POST' });
    await drainFixtureWorker(restartedClient, providers);

    const finalRun = await repository.getRun(created.id);
    const finalDelivery = await repository.getDelivery(firstDelivery.id);
    assert.equal(finalRun?.stages.deliver?.state, 'done');
    assert.equal(finalDelivery?.state, 'succeeded');
    assert.equal(finalDelivery?.response?.status, 'already_imported');
    assert.equal(finalRun?.approvedChecksum, review.package.packageChecksum);
    assert.equal(deliveryAdapter.requests.length, 2);
    assert.deepEqual(
      deliveryAdapter.requests.map(({ idempotencyKey }) => idempotencyKey),
      [firstDelivery.idempotencyKey, firstDelivery.idempotencyKey],
    );
    for (const request of deliveryAdapter.requests) {
      assert.equal(request.packageVersionId, review.package.id);
      assert.equal(request.packageChecksum, review.package.packageChecksum);
      assert.equal(request.knowledgeBits.packageChecksum, review.package.packageChecksum);
      assert.equal(request.knowledgeBits.approval.approvedChecksum, review.package.packageChecksum);
    }
    assert.deepEqual(
      ['research', 'create', 'check', 'produce_assets', 'human_review', 'deliver']
        .map((stage) => finalRun?.stages[stage]?.state),
      ['done', 'done', 'done', 'done', 'done', 'done'],
    );
  },
);

class FixtureStorageAdapter {
  objects = new Map();

  async preparePut({ storageKey, mediaType }) {
    return {
      uploadUrl: `https://fixture-storage.example.test/${encodeURIComponent(storageKey)}`,
      requiredHeaders: { 'Content-Type': mediaType },
    };
  }

  async inspect(storageKey) {
    const object = this.objects.get(storageKey);
    assert.ok(object, `fixture storage object ${storageKey} should exist`);
    return {
      checksum: createHash('sha256').update(object.body).digest('hex'),
      byteSize: object.body.byteLength,
      mediaType: object.mediaType,
    };
  }

  async read(storageKey) {
    const object = this.objects.get(storageKey);
    assert.ok(object, `fixture storage object ${storageKey} should exist`);
    return object.body;
  }

  async put(url, init) {
    const storageKey = decodeURIComponent(new URL(url).pathname.slice(1));
    const body = new Uint8Array(await new Response(init.body).arrayBuffer());
    this.objects.set(storageKey, {
      body,
      mediaType: new Headers(init.headers).get('Content-Type'),
    });
    return new Response(null, { status: 204 });
  }
}

function createRoutedFetch(app, storage) {
  return async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (new URL(url).hostname === 'fixture-storage.example.test') return storage.put(url, init);
    return app.request(url, init);
  };
}

async function drainFixtureWorker(client, providers, stopAfterJobs = Number.POSITIVE_INFINITY) {
  const executor = new WorkerExecutor({ client, providers });
  let completed = 0;
  while (completed < stopAfterJobs) {
    const job = await client.claim(30);
    if (!job) return completed;
    await executor.execute(job);
    completed += 1;
  }
  return completed;
}

function workerCredential(workerId, token) {
  return {
    workerId,
    token,
    capabilities: ['collect_sources', 'create_content', 'check_content', 'produce_assets', 'deliver_package'],
  };
}

async function requestJson(app, path, token, options = {}) {
  const response = await app.request(`https://engine.example.test${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const responseBody = await response.text();
  assert.equal(response.status, options.expectedStatus ?? 200, responseBody);
  return JSON.parse(responseBody);
}

async function startPostgres(containerName) {
  run('docker', [
    'run', '--detach', '--rm', '--name', containerName,
    '--env', 'POSTGRES_USER=postgres',
    '--env', 'POSTGRES_PASSWORD=postgres',
    '--env', 'POSTGRES_DB=knowledge_bits_fixture',
    '--publish', '127.0.0.1::5432',
    'postgres:16-alpine',
  ]);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (spawnSync('docker', ['exec', containerName, 'pg_isready', '-U', 'postgres', '-d', 'knowledge_bits_fixture'], {
      stdio: 'ignore',
    }).status === 0) {
      const port = run('docker', ['port', containerName, '5432/tcp']).match(/:(\d+)\s*$/m)?.[1];
      assert.ok(port, 'PostgreSQL fixture port should resolve');
      return `postgresql://postgres:postgres@127.0.0.1:${port}/knowledge_bits_fixture?schema=public`;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Fixture PostgreSQL did not become ready');
}

async function deployMigrations(databaseUrl) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
        cwd: apiRoot,
        env: { ...process.env, DATABASE_URL: '', ENGINE_DATABASE_URL: databaseUrl },
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

function removeContainer(containerName) {
  spawnSync('docker', ['rm', '--force', containerName], { stdio: 'ignore' });
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}
