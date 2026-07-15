import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import type {
  ArtifactCompleteRequest,
  ArtifactPrepareRequest,
  ArtifactPrepareResponse,
  JobClaim,
  JobResult,
} from '@knowledge-bits/contracts';

import {
  WorkerExecutor,
  operationIdempotencyKey,
  type IntervalScheduler,
} from './executor.js';
import type { WorkerEngineClient } from './engine-client.js';
import { FixtureProvider } from './providers/fixture.js';
import { composeWorkerProviders, runProcess } from './runtime.js';
import {
  ProviderNeedsHumanError,
  type ProviderExecution,
  type WorkerProvider,
} from './providers/types.js';

const now = '2026-07-12T18:00:00.000Z';
const retryAt = '2026-07-12T18:05:00.000Z';

test('reports a provider wait without creating fallback artifacts', async () => {
  const client = new FakeEngineClient();
  const provider = providerFor('collect_sources', {
    kind: 'waiting',
    reason: 'notebooklm_cooldown',
    retryAt,
  });
  const executor = new WorkerExecutor({ client, providers: [provider], now: () => new Date(now) });

  await executor.execute(job('research'));

  assert.equal(client.results.length, 1);
  assert.equal(client.results[0]?.result.state, 'waiting');
  assert.equal(client.results[0]?.retryAt, retryAt);
  assert.equal(client.completedArtifacts.length, 0);
  assert.equal(client.uploadedArtifacts.length, 0);
});

test('delegates delivery claims to the API delivery service without a worker provider', async () => {
  const client = new FakeEngineClient();
  const executor = new WorkerExecutor({ client, providers: [] });
  const deliveryJob = {
    ...job('deliver'),
    deliveryId: randomUUID(),
    packageVersionId: randomUUID(),
    packageChecksum: 'a'.repeat(64),
  };

  await executor.execute(deliveryJob);

  assert.deepEqual(client.deliveries, [deliveryJob.deliveryId]);
  assert.equal(client.results.length, 0);
});

test('heartbeats while the API delivery service is running', async () => {
  const gate = deferred<void>();
  const scheduler = new FakeScheduler();
  const client = new FakeEngineClient({ onDelivery: () => gate.promise });
  const executor = new WorkerExecutor({ client, providers: [], scheduler });
  const deliveryJob = { ...job('deliver'), deliveryId: randomUUID() };

  const execution = executor.execute(deliveryJob);
  await scheduler.tick();
  assert.equal(client.heartbeats, 1);
  gate.resolve();
  await execution;
});

test('reports an operator-fixable provider configuration error as needs human', async () => {
  const client = new FakeEngineClient();
  const provider: WorkerProvider = {
    name: 'failing-provider',
    capabilities: ['collect_sources'],
    async execute() {
      throw new ProviderNeedsHumanError('provider_runtime_unconfigured:notebooklm');
    },
  };
  const executor = new WorkerExecutor({ client, providers: [provider], now: () => new Date(now) });

  await executor.execute(job('research'));

  assert.equal(client.results[0]?.result.state, 'needs_human');
  assert.equal(client.results[0]?.result.needsHumanKind, 'configuration');
  assert.equal(client.results[0]?.result.error, 'provider_runtime_unconfigured:notebooklm');
  assert.equal(client.completedArtifacts.length, 0);
});

test('reports malformed media provider configuration after claiming the job', async () => {
  const client = new FakeEngineClient();
  const providers = composeWorkerProviders({
    env: {
      MEDIA_GENERATION_COMMAND: 'media-provider',
      MEDIA_GENERATION_ARGS: '{',
    },
    engineClient: client,
  });
  const executor = new WorkerExecutor({ client, providers, now: () => new Date(now) });

  await executor.execute(job('produce_assets'));

  assert.equal(client.results[0]?.result.state, 'needs_human');
  assert.equal(client.results[0]?.result.needsHumanKind, 'configuration');
  assert.equal(client.results[0]?.result.error, 'media_generation_args_invalid');
});

test('reports a missing local provider executable as needs human instead of waiting', async () => {
  const client = new FakeEngineClient();
  const command = `/missing/knowledge-bits-provider-${randomUUID()}`;
  const provider: WorkerProvider = {
    name: 'missing-local-provider',
    capabilities: ['produce_assets'],
    async execute(input) {
      await runProcess({
        command,
        args: [],
        timeoutMs: 1_000,
        signal: input.signal,
      });
      throw new Error('missing executable unexpectedly ran');
    },
  };
  const executor = new WorkerExecutor({ client, providers: [provider], now: () => new Date(now) });

  await executor.execute(job('produce_assets'));

  assert.equal(client.results[0]?.result.state, 'needs_human');
  assert.equal(client.results[0]?.result.needsHumanKind, 'configuration');
  assert.equal(client.results[0]?.result.error, `provider_executable_not_found:${command}`);
});

test('execution deadline stops heartbeats, reports a wait, and preserves the provider idempotency key on reclaim', async () => {
  const client = new FakeEngineClient();
  const scheduler = new FakeScheduler();
  const observedKeys: string[] = [];
  let attempt = 0;
  const provider: WorkerProvider = {
    name: 'deadline-provider',
    capabilities: ['collect_sources'],
    async execute(input) {
      observedKeys.push(input.idempotencyKey);
      attempt += 1;
      if (attempt === 1) {
        return new Promise((resolve) => {
          input.signal.addEventListener('abort', () => resolve(successOutput()), { once: true });
        });
      }
      return successOutput();
    },
  };
  const executor = new WorkerExecutor({ client, providers: [provider], scheduler, now: () => new Date(now) });
  const firstJob = job('research', { executionSeconds: 1 });
  const first = executor.execute(firstJob);
  await scheduler.triggerTimeout();
  await first;
  await scheduler.tick();

  assert.equal(client.heartbeats, 0);
  assert.equal(client.results[0]?.result.state, 'waiting');
  assert.equal(client.results[0]?.result.error, 'execution_deadline_exceeded');

  await executor.execute({ ...firstJob, attempt: 2 });
  assert.equal(observedKeys[0], observedKeys[1]);
  assert.equal(client.events.filter((event) => event === 'report:done').length, 1);
});

test('uploads raw response, parsed output, and execution report before a successful result', async () => {
  const client = new FakeEngineClient();
  const provider = providerFor('produce_assets', successOutput());
  const executor = new WorkerExecutor({ client, providers: [provider], now: () => new Date(now) });

  await executor.execute(job('produce_assets'));

  assert.deepEqual(client.completedArtifacts.map(({ kind }) => kind), [
    'raw_response',
    'parsed_output',
    'generation.execution.report',
  ]);
  assert.equal(client.results.length, 1);
  assert.equal(client.results[0]?.result.state, 'done');
  assert.equal(client.events.at(-1), 'report:done');
  assert.match(client.results[0]?.result.outputChecksum ?? '', /^[a-f0-9]{64}$/);
});

test('uploads generated media bytes with their media metadata and content checksum before audit artifacts', async () => {
  const client = new FakeEngineClient();
  const contentChecksum = 'a'.repeat(64);
  const hero = Buffer.from([1, 2, 3]);
  const infographic = Buffer.from([4, 5]);
  const audio = Buffer.from([6, 7, 8, 9]);
  const provider = providerFor('produce_assets', {
    ...successOutput(),
    inputChecksum: contentChecksum,
    assets: [
      { kind: 'hero', mediaType: 'image/webp', body: hero, inputChecksum: contentChecksum },
      { kind: 'infographic', mediaType: 'image/png', body: infographic, inputChecksum: contentChecksum },
      { kind: 'audio', mediaType: 'audio/mpeg', body: audio, inputChecksum: contentChecksum },
    ],
  });
  const executor = new WorkerExecutor({ client, providers: [provider], now: () => new Date(now) });

  await executor.execute(job('produce_assets'));

  assert.deepEqual(client.completedArtifacts.map(({ kind }) => kind), [
    'hero',
    'infographic',
    'audio',
    'raw_response',
    'parsed_output',
    'generation.execution.report',
  ]);
  assert.deepEqual(client.uploadedArtifacts.slice(0, 3).map(({ body }) => Buffer.from(body)), [hero, infographic, audio]);
  assert.deepEqual(client.completedArtifacts.slice(0, 3).map(({ mediaType }) => mediaType), [
    'image/webp',
    'image/png',
    'audio/mpeg',
  ]);
  assert.deepEqual(client.completedArtifacts.slice(0, 3).map(({ checksum }) => checksum), [
    checksum(hero),
    checksum(infographic),
    checksum(audio),
  ]);
  assert.deepEqual(client.completedArtifacts.slice(0, 3).map(({ inputChecksum }) => inputChecksum), [
    contentChecksum,
    contentChecksum,
    contentChecksum,
  ]);
  assert.equal(client.events.at(-1), 'report:done');
});

test('uploads the audit artifact triplet before reporting a non-asset success', async () => {
  const client = new FakeEngineClient();
  const provider = providerFor('collect_sources', successOutput());
  const executor = new WorkerExecutor({ client, providers: [provider], now: () => new Date(now) });

  await executor.execute(job('research'));

  assert.deepEqual(client.completedArtifacts.map(({ kind }) => kind), [
    'raw_response',
    'parsed_output',
    'generation.execution.report',
  ]);
  assert.equal(client.events.at(-1), 'report:done');
});

test('uploads immutable recipe and prompt support artifacts during a non-media stage', async () => {
  const client = new FakeEngineClient();
  const claimedJob = job('research');
  const recipeBody = Buffer.from('{"id":"nuglet.lesson.story","version":"1.0.0"}\n');
  const promptBody = Buffer.from('Create the Story.');
  const provenance = generationProvenance(recipeBody, promptBody);
  const provider = providerFor('collect_sources', {
    ...successOutput(),
    supportArtifacts: [
      {
        kind: 'generation.recipe.snapshot',
        mediaType: 'application/json',
        body: recipeBody,
        inputChecksum: null,
        provenance,
      },
      {
        kind: 'generation.prompt.rendered',
        mediaType: 'text/plain',
        body: promptBody,
        inputChecksum: prefixedChecksum(recipeBody),
        provenance,
      },
    ],
  });
  const executor = new WorkerExecutor({ client, providers: [provider], now: () => new Date(now) });

  await executor.execute(claimedJob);

  assert.deepEqual(client.completedArtifacts.map(({ kind }) => kind), [
    'generation.recipe.snapshot',
    'generation.prompt.rendered',
    'raw_response',
    'parsed_output',
    'generation.execution.report',
  ]);
  for (const artifact of client.completedArtifacts.filter(({ kind }) => kind.startsWith('generation.'))) {
    assert.deepEqual(
      Object.keys(artifact.provenance).filter((key) => [
        'recipeId', 'recipeVersion', 'recipeChecksum', 'promptChecksum',
        'provider', 'model', 'attempt', 'referenceChecksums',
      ].includes(key)).sort(),
      ['attempt', 'model', 'promptChecksum', 'provider', 'recipeChecksum', 'recipeId', 'recipeVersion', 'referenceChecksums'],
    );
    assert.equal(artifact.provenance.action, 'collect_sources');
    assert.equal(artifact.provenance.jobId, claimedJob.jobId);
    assert.equal(artifact.provenance.provider, 'fixture-provider');
    assert.equal(artifact.provenance.attempt, claimedJob.attempt);
    assert.equal(artifact.provenance.idempotencyKey, operationIdempotencyKey(claimedJob, 'collect_sources'));
  }
});

test('rejects missing, conflicting, and body-mismatched generation provenance before uploading artifacts', async (context) => {
  const recipeBody = Buffer.from('{"id":"nuglet.lesson.story","version":"1.0.0"}\n');
  const promptBody = Buffer.from('Create the Story.');
  const provenance = generationProvenance(recipeBody, promptBody);
  const cases: Array<{
    name: string;
    reason: string;
    provenance: Readonly<Record<string, unknown>>;
    promptProvenance?: Readonly<Record<string, unknown>>;
  }> = [
    {
      name: 'missing reference checksums',
      reason: 'generation_provenance_missing',
      provenance: Object.fromEntries(Object.entries(provenance).filter(([key]) => key !== 'referenceChecksums')),
    },
    {
      name: 'conflicting executor-bound provider',
      reason: 'generation_provenance_conflict',
      provenance: { ...provenance, provider: 'forged-provider' },
    },
    {
      name: 'conflicting prompt provenance',
      reason: 'generation_provenance_conflict',
      provenance,
      promptProvenance: { ...provenance, model: 'different-model' },
    },
    {
      name: 'recipe checksum that does not match the recipe snapshot',
      reason: 'generation_provenance_checksum_mismatch',
      provenance: { ...provenance, recipeChecksum: `sha256:${'f'.repeat(64)}` },
    },
  ];

  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      const client = new FakeEngineClient();
      const provider = providerFor('collect_sources', {
        ...successOutput(),
        supportArtifacts: [
          {
            kind: 'generation.recipe.snapshot',
            mediaType: 'application/json',
            body: recipeBody,
            inputChecksum: null,
            provenance: scenario.provenance,
          },
          {
            kind: 'generation.prompt.rendered',
            mediaType: 'text/plain',
            body: promptBody,
            inputChecksum: prefixedChecksum(recipeBody),
            provenance: scenario.promptProvenance ?? scenario.provenance,
          },
        ],
      });
      const executor = new WorkerExecutor({ client, providers: [provider], now: () => new Date(now) });

      await executor.execute(job('research'));

      assert.equal(client.completedArtifacts.length, 0);
      assert.equal(client.results[0]?.result.state, 'needs_human');
      assert.equal(client.results[0]?.result.error, scenario.reason);
    });
  }
});

test('keeps learner media stage-restricted while allowing research source snapshots', async () => {
  const blockedClient = new FakeEngineClient();
  const blockedProvider = providerFor('create_content', {
    ...successOutput(),
    assets: [{
      kind: 'hero',
      mediaType: 'image/webp',
      body: Buffer.from('not-allowed'),
      inputChecksum: null,
    }],
  });
  const blockedExecutor = new WorkerExecutor({ client: blockedClient, providers: [blockedProvider], now: () => new Date(now) });

  await blockedExecutor.execute(job('create'));

  assert.equal(blockedClient.results[0]?.result.state, 'needs_human');
  assert.equal(blockedClient.results[0]?.result.error, 'provider_assets_not_allowed_for_stage');
  assert.equal(blockedClient.completedArtifacts.length, 0);

  const researchClient = new FakeEngineClient();
  const researchProvider = providerFor('collect_sources', {
    ...successOutput(),
    assets: [{
      kind: 'source_snapshot',
      mediaType: 'text/html',
      body: Buffer.from('<main>source</main>'),
      inputChecksum: null,
    }],
  });
  const researchExecutor = new WorkerExecutor({ client: researchClient, providers: [researchProvider], now: () => new Date(now) });

  await researchExecutor.execute(job('research'));

  assert.equal(researchClient.completedArtifacts[0]?.kind, 'source_snapshot');
  assert.equal(researchClient.results[0]?.result.state, 'done');
});

test('removes credentials, path fields, and embedded absolute paths from generation execution reports', async () => {
  const secret = 'task-four-secret-value';
  const credential = 'sk_live_task_four_credential';
  const recipeBody = Buffer.from('{"id":"safe"}\n');
  const promptBody = Buffer.from('safe prompt');
  const previous = process.env.TASK_FOUR_SECRET;
  process.env.TASK_FOUR_SECRET = secret;
  try {
    const client = new FakeEngineClient();
    const provider = providerFor('collect_sources', {
      ...successOutput(),
      supportArtifacts: [{
        kind: 'generation.recipe.snapshot',
        mediaType: 'application/json',
        body: recipeBody,
        inputChecksum: null,
        provenance: {
          ...generationProvenance(recipeBody, promptBody),
          secretToken: secret,
          localPath: '/Users/private/recipes',
          cwd: '/srv/knowledge-bits',
          loadedFrom: '/opt/worker/config.json',
          filename: '/workspace/recipe.json',
        },
      }, {
        kind: 'generation.prompt.rendered',
        mediaType: 'text/plain',
        body: promptBody,
        inputChecksum: prefixedChecksum(recipeBody),
        provenance: generationProvenance(recipeBody, promptBody),
      }],
      executionReport: {
        model: 'provider-model',
        apiKey: secret,
        nested: { authorization: `Bearer ${secret}` },
        recipeRoot: '/Users/private/recipes',
        cwd: '/srv/knowledge-bits',
        loadedFrom: '/opt/worker/config.json',
        filename: '/workspace/recipe.json',
        error: `Could not load:/mnt/recipes/manifest.json with token=${credential}`,
        safeSetting: 'kept',
      },
    });
    const executor = new WorkerExecutor({ client, providers: [provider], now: () => new Date(now) });

    await executor.execute(job('research'));

    const reportIndex = client.completedArtifacts.findIndex(({ kind }) => kind === 'generation.execution.report');
    const report = Buffer.from(client.uploadedArtifacts[reportIndex]!.body).toString('utf8');
    assert.equal(report.includes(secret), false);
    assert.equal(report.includes('/Users/private/recipes'), false);
    assert.equal(report.includes('apiKey'), false);
    assert.equal(report.includes('authorization'), false);
    assert.equal(report.includes('recipeRoot'), false);
    assert.equal(report.includes('cwd'), false);
    assert.equal(report.includes('loadedFrom'), false);
    assert.equal(report.includes('filename'), false);
    assert.equal(report.includes('/srv/knowledge-bits'), false);
    assert.equal(report.includes('/opt/worker/config.json'), false);
    assert.equal(report.includes('/workspace/recipe.json'), false);
    assert.equal(report.includes('/mnt/recipes/manifest.json'), false);
    assert.equal(report.includes(credential), false);
    assert.match(report, /safeSetting/);
    const recipeProvenance = JSON.stringify(client.completedArtifacts.find(
      ({ kind }) => kind === 'generation.recipe.snapshot',
    )?.provenance);
    assert.equal(recipeProvenance.includes(secret), false);
    assert.equal(recipeProvenance.includes('/Users/private/recipes'), false);
    assert.equal(recipeProvenance.includes('secretToken'), false);
    assert.equal(recipeProvenance.includes('localPath'), false);
    assert.equal(recipeProvenance.includes('cwd'), false);
    assert.equal(recipeProvenance.includes('loadedFrom'), false);
    assert.equal(recipeProvenance.includes('filename'), false);
  } finally {
    if (previous === undefined) delete process.env.TASK_FOUR_SECRET;
    else process.env.TASK_FOUR_SECRET = previous;
  }
});

test('uses the claimed revision for audit artifacts instead of an executor default', async () => {
  const client = new FakeEngineClient();
  const provider = providerFor('produce_assets', successOutput());
  const executor = new WorkerExecutor({ client, providers: [provider], now: () => new Date(now) });

  await executor.execute(job('produce_assets', { revision: 2 }));

  assert.deepEqual(client.preparedArtifacts.map(({ revision }) => revision), [2, 2, 2]);
  assert.deepEqual(client.completedArtifacts.map(({ revision }) => revision), [2, 2, 2]);
});

test('heartbeats at one third of the claimed lease duration', async () => {
  const client = new FakeEngineClient();
  const scheduler = new FakeScheduler();
  const gate = deferred<ProviderExecution>();
  const provider = providerFor('collect_sources', gate.promise);
  const executor = new WorkerExecutor({
    client,
    providers: [provider],
    scheduler,
    now: () => new Date(now),
  });
  const execution = executor.execute(job('research', { leaseSeconds: 90 }));

  assert.equal(scheduler.delays[0], 30_000);
  await scheduler.tick();
  assert.equal(client.heartbeats, 1);

  gate.resolve(successOutput());
  await execution;
});

test('stops reporting when heartbeat interruption aborts execution', async () => {
  const client = new FakeEngineClient({ heartbeat: { kind: 'interrupted' } });
  const scheduler = new FakeScheduler();
  const gate = deferred<ProviderExecution>();
  const provider = providerFor('collect_sources', gate.promise);
  const executor = new WorkerExecutor({
    client,
    providers: [provider],
    scheduler,
    now: () => new Date(now),
  });
  const execution = executor.execute(job('research'));

  await scheduler.tick();
  gate.resolve(successOutput());
  await execution;

  assert.equal(client.heartbeats, 1);
  assert.equal(client.results.length, 0);
  assert.equal(client.completedArtifacts.length, 0);
});

test('stops artifact I/O and result reporting when a heartbeat interrupts an upload', async () => {
  const scheduler = new FakeScheduler();
  const client = new FakeEngineClient({
    heartbeat: { kind: 'interrupted' },
    onUpload: () => scheduler.tick(),
  });
  const provider = providerFor('produce_assets', successOutput());
  const executor = new WorkerExecutor({
    client,
    providers: [provider],
    scheduler,
    now: () => new Date(now),
  });

  await executor.execute(job('produce_assets'));

  assert.deepEqual(client.events, [
    'prepare:raw_response',
    'upload:00000000-0000-4000-8000-000000000001',
    'heartbeat',
  ]);
  assert.equal(client.completedArtifacts.length, 0);
  assert.equal(client.results.length, 0);
});

test('uses stable provider operation keys within a revision and rotates them for a new revision', async () => {
  const client = new FakeEngineClient();
  const observedKeys: string[] = [];
  const provider: WorkerProvider = {
    name: 'fixture-content',
    capabilities: ['collect_sources'],
    async execute(input) {
      observedKeys.push(input.idempotencyKey);
      return successOutput();
    },
  };
  const executor = new WorkerExecutor({ client, providers: [provider], now: () => new Date(now) });
  const firstJob = job('research', { revision: 1 });

  await executor.execute(firstJob);
  await executor.execute({ ...firstJob, jobId: randomUUID(), attempt: 2 });
  await executor.execute({ ...firstJob, jobId: randomUUID(), revision: 2 });

  assert.equal(observedKeys[0], observedKeys[1]);
  assert.equal(observedKeys[0], operationIdempotencyKey(firstJob, 'collect_sources'));
  assert.notEqual(observedKeys[1], observedKeys[2]);
});

test('reads deterministic committed fixtures for every worker action', async () => {
  const provider = new FixtureProvider();
  const fixtureJob = job('research');
  const input = {
    job: fixtureJob,
    action: 'collect_sources' as const,
    idempotencyKey: operationIdempotencyKey(fixtureJob, 'collect_sources'),
    signal: new AbortController().signal,
  };

  const first = await provider.execute(input);
  const second = await provider.execute(input);

  assert.equal(first.kind, 'success');
  assert.equal(second.kind, 'success');
  if (first.kind !== 'success' || second.kind !== 'success') return;
  assert.equal(checksum(first.rawResponse), checksum(second.rawResponse));
  assert.deepEqual(provider.capabilities, [
    'collect_sources',
    'create_content',
    'check_content',
    'produce_assets',
    'deliver_package',
  ]);
});

function job(
  stage: JobClaim['stage'],
  options: { leaseSeconds?: number; revision?: number; executionSeconds?: number } = {},
): JobClaim {
  const leaseSeconds = options.leaseSeconds ?? 60;
  return {
    jobId: randomUUID(),
    packageId: randomUUID(),
    stage,
    claimedBy: 'fixture-worker',
    claimedAt: now,
    leaseExpiresAt: new Date(new Date(now).getTime() + leaseSeconds * 1_000).toISOString(),
    executionDeadlineAt: new Date(new Date(now).getTime() + (options.executionSeconds ?? 300) * 1_000).toISOString(),
    attempt: 1,
    revision: options.revision ?? 1,
    input: { brief: {}, dependencies: [] },
  };
}

function successOutput(): Extract<ProviderExecution, { kind: 'success' }> {
  return {
    kind: 'success',
    rawResponse: Buffer.from('{"fixture":"response"}\n'),
    parsedOutput: { fixture: 'parsed-output' },
    executionReport: { fixture: 'execution-report' },
  };
}

function providerFor(
  action: WorkerProvider['capabilities'][number],
  result: ProviderExecution | Promise<ProviderExecution>,
): WorkerProvider {
  return {
    name: 'fixture-provider',
    capabilities: [action],
    async execute() {
      return result;
    },
  };
}

class FakeEngineClient implements WorkerEngineClient {
  readonly completedArtifacts: ArtifactCompleteRequest[] = [];
  readonly events: string[] = [];
  readonly results: Array<{ result: JobResult; retryAt?: string }> = [];
  readonly uploadedArtifacts: Array<{ artifactId: string; body: Uint8Array }> = [];
  readonly preparedArtifacts: ArtifactPrepareRequest[] = [];
  readonly deliveries: string[] = [];
  heartbeats = 0;
  private artifactSequence = 0;

  constructor(private readonly options: {
    heartbeat?: { kind: 'continue' | 'interrupted' };
    onDelivery?: () => Promise<void>;
    onUpload?: () => Promise<void>;
  } = {}) {}

  async claim(): Promise<JobClaim | null> {
    return null;
  }

  async heartbeat(): Promise<{ kind: 'continue' | 'interrupted' }> {
    this.heartbeats += 1;
    this.events.push('heartbeat');
    return this.options.heartbeat ?? { kind: 'continue' };
  }

  async readArtifact(): Promise<{ body: Uint8Array; mediaType: string }> {
    throw new Error('not used');
  }

  async prepareArtifact(input: ArtifactPrepareRequest): Promise<ArtifactPrepareResponse> {
    this.preparedArtifacts.push(input);
    this.artifactSequence += 1;
    const artifactId = `00000000-0000-4000-8000-${String(this.artifactSequence).padStart(12, '0')}`;
    this.events.push(`prepare:${input.kind}`);
    return {
      artifactId,
      storageKey: `knowledge-bits/${input.runId}/${input.revision}/${artifactId}`,
      uploadUrl: `https://storage.example.test/${artifactId}`,
      requiredHeaders: {},
    };
  }

  async uploadArtifact(prepared: ArtifactPrepareResponse, body: Uint8Array): Promise<void> {
    this.uploadedArtifacts.push({ artifactId: prepared.artifactId, body });
    this.events.push(`upload:${prepared.artifactId}`);
    await this.options.onUpload?.();
  }

  async completeArtifact(input: ArtifactCompleteRequest): Promise<void> {
    this.completedArtifacts.push(input);
    this.events.push(`complete:${input.kind}`);
  }

  async reportResult(result: JobResult, retryAtValue?: string): Promise<void> {
    this.results.push({ result, retryAt: retryAtValue });
    this.events.push(`report:${result.state}`);
  }

  async runDelivery(job: JobClaim): Promise<void> {
    if (!job.deliveryId) throw new Error('missing delivery id');
    this.deliveries.push(job.deliveryId);
    await this.options.onDelivery?.();
  }
}

class FakeScheduler implements IntervalScheduler {
  readonly delays: number[] = [];
  private intervalCallback: (() => void | Promise<void>) | undefined;
  private timeoutCallback: (() => void | Promise<void>) | undefined;

  setInterval(callback: () => void | Promise<void>, delay: number): object {
    this.intervalCallback = callback;
    this.delays.push(delay);
    return {};
  }

  clearInterval(): void { this.intervalCallback = undefined; }

  setTimeout(callback: () => void | Promise<void>, _delay: number): object {
    this.timeoutCallback = callback;
    return {};
  }

  clearTimeout(): void { this.timeoutCallback = undefined; }

  async tick(): Promise<void> {
    await this.intervalCallback?.();
  }

  async triggerTimeout(): Promise<void> {
    const callback = this.timeoutCallback;
    this.timeoutCallback = undefined;
    await callback?.();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function checksum(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function prefixedChecksum(bytes: Uint8Array): string {
  return `sha256:${checksum(bytes)}`;
}

function generationProvenance(recipeBody: Uint8Array, promptBody: Uint8Array) {
  return {
    recipeId: 'nuglet.lesson.story',
    recipeVersion: '1.0.0',
    recipeChecksum: prefixedChecksum(recipeBody),
    promptChecksum: prefixedChecksum(promptBody),
    model: 'fixture-model',
    referenceChecksums: ['sha256:'.concat('b'.repeat(64))],
  };
}
