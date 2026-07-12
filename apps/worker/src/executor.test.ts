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
import type { ProviderExecution, WorkerProvider } from './providers/types.js';

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

test('reports a provider error as a typed retry for a non-review stage', async () => {
  const client = new FakeEngineClient();
  const provider: WorkerProvider = {
    name: 'failing-provider',
    capabilities: ['collect_sources'],
    async execute() {
      throw new Error('provider temporarily unavailable');
    },
  };
  const executor = new WorkerExecutor({ client, providers: [provider], now: () => new Date(now) });

  await executor.execute(job('research'));

  assert.equal(client.results[0]?.result.state, 'waiting');
  assert.equal(client.results[0]?.result.error, 'provider temporarily unavailable');
  assert.equal(client.completedArtifacts.length, 0);
});

test('uploads raw response, parsed output, and execution report before a successful result', async () => {
  const client = new FakeEngineClient();
  const provider = providerFor('produce_assets', successOutput());
  const executor = new WorkerExecutor({ client, providers: [provider], now: () => new Date(now) });

  await executor.execute(job('produce_assets'));

  assert.deepEqual(client.completedArtifacts.map(({ kind }) => kind), [
    'raw_response',
    'parsed_output',
    'execution_report',
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
    'execution_report',
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
    'execution_report',
  ]);
  assert.equal(client.events.at(-1), 'report:done');
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
  options: { leaseSeconds?: number; revision?: number } = {},
): JobClaim {
  const leaseSeconds = options.leaseSeconds ?? 60;
  return {
    jobId: randomUUID(),
    packageId: randomUUID(),
    stage,
    claimedBy: 'fixture-worker',
    claimedAt: now,
    leaseExpiresAt: new Date(new Date(now).getTime() + leaseSeconds * 1_000).toISOString(),
    attempt: 1,
    revision: options.revision ?? 1,
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
  heartbeats = 0;
  private artifactSequence = 0;

  constructor(private readonly options: {
    heartbeat?: { kind: 'continue' | 'interrupted' };
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
}

class FakeScheduler implements IntervalScheduler {
  readonly delays: number[] = [];
  private callback: (() => void | Promise<void>) | undefined;

  setInterval(callback: () => void | Promise<void>, delay: number): object {
    this.callback = callback;
    this.delays.push(delay);
    return {};
  }

  clearInterval(): void {}

  async tick(): Promise<void> {
    await this.callback?.();
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
