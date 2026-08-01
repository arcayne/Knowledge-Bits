import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import test from 'node:test';

import { createApp } from '../../apps/api/dist/app.js';
import { createIsolatedPrismaClient } from '../../apps/api/dist/config.js';
import { createWorkflowRepository } from '../../apps/api/dist/repositories/workflow-repository.js';
import { FixtureDeliveryAdapter } from '../../apps/api/dist/services/delivery-adapters/fixture.js';
import { HttpEngineClient } from '../../apps/worker/dist/engine-client.js';
import { WorkerExecutor } from '../../apps/worker/dist/executor.js';
import { composeWorkerProviders } from '../../apps/worker/dist/runtime.js';
import { calculateContentChecksum } from '../../packages/pipeline/dist/package-builder.js';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const apiRoot = fileURLToPath(new URL('../../apps/api/', import.meta.url));
const fixtureRoot = fileURLToPath(new URL('../fixtures/attention-recovery/', import.meta.url));
const providerRoot = fileURLToPath(new URL('../fixtures/attention-recovery/providers/', import.meta.url));
const requireFromApi = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { serve } = requireFromApi('@hono/node-server');
const dockerUnavailable = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 30_000 }).status !== 0;

test(
  'brief becomes one approved and verified Knowledge Bits delivery',
  { skip: dockerUnavailable ? 'Docker is unavailable' : false, timeout: 120_000 },
  async (t) => {
    const containerName = `knowledge-bits-e2e-${randomUUID()}`;
    const databaseUrl = await startPostgres(containerName);
    t.after(() => removeContainer(containerName));
    await deployMigrations(databaseUrl);
    const runtimeDatabaseUrl = createRestrictedRuntimeLogin(containerName, databaseUrl);

    const prisma = createIsolatedPrismaClient({ ENGINE_DATABASE_URL: runtimeDatabaseUrl });
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
        ENGINE_WORKER_CREDENTIALS: JSON.stringify([
          workerCredential('fixture-worker-before-restart', 'fixture-worker-token-a'),
          workerCredential('fixture-worker-after-restart', 'fixture-worker-token-b'),
        ]),
      },
    });
    const apiRuntime = await startApiServer(app);
    const identityRuntime = await startIdentityServer();
    const reviewRuntime = await startReviewServer(
      apiRuntime.url,
      'fixture-review-token',
      identityRuntime,
    );
    t.after(async () => {
      await stopProcess(reviewRuntime.process);
      await closeServer(identityRuntime.server);
      await closeServer(apiRuntime.server);
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

    const identityHeaders = { 'Cf-Access-Jwt-Assertion': identityRuntime.token };
    const pageResponse = await fetch(`${reviewRuntime.url}/runs/${created.id}`, { headers: identityHeaders });
    const pageHtml = await pageResponse.text();
    assert.equal(pageResponse.status, 200, pageHtml);
    assert.match(pageHtml, new RegExp(`data-run-id="${created.id}"`));

    const csrfToken = pageHtml.match(/<meta name="review-csrf-token" content="([^"]+)"/)?.[1];
    const csrfCookie = pageResponse.headers.get('set-cookie')?.split(';')[0];
    assert.ok(csrfToken, 'review page should expose its bound CSRF token');
    assert.ok(csrfCookie, 'review page should set its bound CSRF cookie');
    const reviewResponse = await fetch(`${reviewRuntime.url}/api/review?runId=${created.id}`, {
      headers: identityHeaders,
    });
    const reviewText = await reviewResponse.text();
    assert.equal(reviewResponse.status, 200, reviewText);
    const review = JSON.parse(reviewText);
    assert.equal(review.currentStage, 'human_review');
    assert.equal(review.decisionAllowed, true);
    assert.deepEqual(review.issues, []);
    assert.ok(review.package);
    assert.equal(review.currentPackageChecksum, review.package.packageChecksum);
    assert.equal(review.package.evidence.acceptedSources.length, 2);
    assert.ok(review.package.evidence.acceptedSources.every(({ url }) => new URL(url).hostname === 'example.test'));
    assert.ok(review.package.evidence.acceptedSources.every(({ snapshot }) => snapshot.kind === 'source_snapshot'));
    assert.deepEqual(review.package.evidence.rejectedSources, []);
    assert.deepEqual(review.package.evidence.coverageGaps, []);
    assert.ok(review.package.evidence.claims.every(({ citations }) => citations.length > 0));
    assert.ok(review.package.content.target.payload.claims.every(({ citations }) => citations.length > 0));
    assert.equal(review.package.content.target.payload.title, fixtureCandidate.title);
    assert.equal(review.package.content.target.payload.takeaway, fixtureCandidate.takeaway);
    assert.equal(review.package.content.target.payload.action, fixtureCandidate.action);
    assert.deepEqual(review.package.content.target.payload.depths, fixtureCandidate.depths);
    assert.deepEqual(review.package.content.target.payload.claimCoverage, fixtureCandidate.claimCoverage);
    assert.equal(review.package.content.target.payload.claims.length, fixtureCandidate.claims.length);
    const contentChecksum = calculateContentChecksum(review.package.content.target.payload);
    assert.equal(review.package.qa.deterministic.contentChecksum, contentChecksum);
    const legacyMedia = review.package.artifactInventory
      .filter(({ kind }) => ['hero', 'infographic', 'audio_brief', 'audio_discussion'].includes(kind));
    assert.deepEqual(legacyMedia.map(({ kind }) => kind), [
      'hero',
      'infographic',
      'audio_brief',
      'audio_discussion',
    ]);
    assert.ok(legacyMedia.every(({ inputChecksum }) => inputChecksum === contentChecksum));
    assert.deepEqual(
      Object.fromEntries(Object.entries(review.assets).map(([key, { state }]) => [key, state])),
      {
        hero: 'available',
        infographic: 'available',
        audioBrief: 'available',
        audioDiscussion: 'available',
        audioConversation: 'missing',
        publicPreview: 'missing',
      },
    );

    const surfaceChecksum = review.currentPackageChecksum;
    assert.equal(surfaceChecksum, review.package.packageChecksum);
    const approvalResponse = await fetch(`${reviewRuntime.url}/api/review`, {
      method: 'POST',
      headers: {
        ...identityHeaders,
        'Content-Type': 'application/json',
        Cookie: csrfCookie,
        Origin: reviewRuntime.url,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ runId: created.id, decision: 'approve', packageChecksum: surfaceChecksum }),
    });
    const approvalText = await approvalResponse.text();
    assert.equal(approvalResponse.status, 200, approvalText);
    const approval = JSON.parse(approvalText);
    assert.equal(approval.approvedChecksum, surfaceChecksum);
    assert.equal((await prisma.review.findFirst({ where: { runId: created.id } }))?.reviewerId, 'fixture-editor');
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
    assert.equal(finalDelivery?.response?.status, 'imported');
    assert.equal(finalRun?.approvedChecksum, review.package.packageChecksum);
    assert.equal(deliveryAdapter.requests.length, 1);
    assert.deepEqual(
      deliveryAdapter.requests.map(({ idempotencyKey }) => idempotencyKey),
      [firstDelivery.idempotencyKey],
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

async function startApiServer(app) {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (address) => {
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
    server.once('error', reject);
  });
}

async function startIdentityServer() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyId = 'fixture-review-key';
  const publicJwk = publicKey.export({ format: 'jwk' });
  const server = createHttpServer((request, response) => {
    if (request.url !== '/.well-known/jwks.json') {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ keys: [{ ...publicJwk, alg: 'RS256', kid: keyId, use: 'sig' }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const issuer = `http://127.0.0.1:${address.port}`;
  const audience = 'knowledge-bits-review';
  const now = Math.floor(Date.now() / 1_000);
  const encodedHeader = base64UrlJson({ alg: 'RS256', kid: keyId, typ: 'JWT' });
  const encodedPayload = base64UrlJson({
    aud: audience,
    exp: now + 300,
    iat: now,
    iss: issuer,
    sub: 'fixture-editor',
  });
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
  return {
    server,
    issuer,
    audience,
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    token: `${signingInput}.${signature}`,
  };
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function startReviewServer(apiUrl, token, identity) {
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  const process = spawn('pnpm', [
    '--filter', '@knowledge-bits/review', 'exec', 'astro', 'dev',
    '--host', '127.0.0.1', '--port', String(port),
  ], {
    cwd: repositoryRoot,
    env: {
      ...globalThis.process.env,
      ENGINE_API_URL: apiUrl,
      ENGINE_REVIEW_TOKEN: token,
      REVIEW_AUTH_AUDIENCE: identity.audience,
      REVIEW_AUTH_ISSUER: identity.issuer,
      REVIEW_AUTH_JWKS_URL: identity.jwksUrl,
      REVIEW_PUBLIC_ORIGIN: url,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  process.stdout.on('data', (chunk) => { output += chunk; });
  process.stderr.on('data', (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`Astro review server exited early:\n${output}`);
    try {
      const response = await fetch(url, {
        headers: { 'Cf-Access-Jwt-Assertion': identity.token },
      });
      if (response.ok) return { process, url };
    } catch {
      // The server has not opened its socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stopProcess(process);
  throw new Error(`Astro review server did not become ready:\n${output}`);
}

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await closeServer(server);
  return address.port;
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
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
      timeout: 10_000,
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
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

function createRestrictedRuntimeLogin(containerName, ownerUrl) {
  run('docker', [
    'exec', containerName, 'psql', '--username', 'postgres', '--dbname', 'knowledge_bits_fixture',
    '--set', 'ON_ERROR_STOP=1', '--command', [
      "CREATE ROLE knowledge_bits_runtime_login LOGIN PASSWORD 'runtime-test-password';",
      'GRANT knowledge_bits_runtime TO knowledge_bits_runtime_login;',
    ].join(' '),
  ]);
  const runtimeUrl = new URL(ownerUrl);
  runtimeUrl.username = 'knowledge_bits_runtime_login';
  runtimeUrl.password = 'runtime-test-password';
  return runtimeUrl.toString();
}

function removeContainer(containerName) {
  spawnSync('docker', ['rm', '--force', containerName], { stdio: 'ignore', timeout: 30_000 });
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: options.timeout ?? 60_000,
  }).trim();
}
