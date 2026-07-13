import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateContentChecksum } from '@knowledge-bits/pipeline';

import {
  composeWorkerProviders,
  LeaseScopedJobContextResolver,
  LocalMediaCommandClient,
  LocalPiSdkClient,
  runProcess,
  type ProviderRuntime,
} from './runtime.js';
import type { WorkerEngineClient } from './engine-client.js';

test('uses fixtures only when fixture mode is explicitly selected', () => {
  const production = composeWorkerProviders({ env: {} });
  const fixtures = composeWorkerProviders({ env: { WORKER_PROVIDER_MODE: 'fixture' } });

  assert.deepEqual(production.map(({ name }) => name), [
    'notebooklm-unavailable',
    'pi-unavailable',
    'media-unavailable',
  ]);
  assert.deepEqual(fixtures.map(({ name }) => name), ['fixture']);
});

test('missing production runtime configuration never returns fixture content', async () => {
  const [notebook] = composeWorkerProviders({ env: {} });
  assert.ok(notebook);

  await assert.rejects(
    () => notebook.execute(input('collect_sources')),
    /provider_runtime_unconfigured:notebooklm/,
  );
});

test('legacy provider service URLs do not create production provider dependencies', () => {
  const providers = composeWorkerProviders({
    env: {
      PROVIDER_CONTEXT_URL: 'https://legacy.example.test',
      PI_EDITORIAL_URL: 'https://legacy.example.test/pi',
      MEDIA_GENERATION_URL: 'https://legacy.example.test/media',
    },
    fetch: async () => { throw new Error('legacy service must not be called'); },
  });
  assert.deepEqual(providers.map(({ name }) => name), [
    'notebooklm-unavailable', 'pi-unavailable', 'media-unavailable',
  ]);
});

test('composes injected production clients and context resolvers without live credentials', async () => {
  const runtime: ProviderRuntime = {
    notebookProcess: {
      async run() {
        return {
          stdout: JSON.stringify({ conversationId: 'notebook-1', answer: { claims: [], sources: [] } }),
          stderr: '',
          exitCode: 0,
        };
      },
    },
    notebookContext: async () => ({ notebookId: 'notebook-1', sourceUrls: [], topic: 'focus' }),
    sourceVerifier: {
      async verify() {
        return {
          evidence: {
            acceptedSources: [{
              sourceId: evidence.sources[0]!.sourceId,
              title: 'Evidence',
              url: 'https://example.test/evidence',
              retrievedAt: '2026-07-13T10:00:00.000Z',
              snapshotChecksum: inputChecksum,
              readability: { passed: true, reason: null },
              credibility: { passed: true, policy: 'fixture.v1', reason: null },
            }],
            rejectedSources: [],
            coverageGaps: [],
          },
          snapshots: [{ kind: 'source_snapshot', mediaType: 'text/plain', body: Buffer.from('evidence'), inputChecksum: null }],
        };
      },
    },
    piClient: { async check() { return { findings: [], summary: 'Ready.' }; } },
    piContext: async () => ({ candidate, evidence, rubric: 'Check it.' }),
    mediaClient: {
      async generate() {
        return [{ kind: 'hero', mediaType: 'image/webp', bytes: Buffer.from('hero'), inputChecksum }];
      },
    },
    mediaContext: async () => ({ passedCheck: true, content: candidate, contentChecksum: inputChecksum }),
  };

  const providers = composeWorkerProviders({ env: {}, runtime });
  assert.deepEqual(providers.map(({ name }) => name), ['notebooklm', 'pi', 'media']);

  const notebook = providers[0];
  assert.ok(notebook);
  const result = await notebook.execute(input('collect_sources'));
  assert.equal(result.kind, 'success');
});

test('reconstructs Pi and media context from lease-scoped artifact dependencies', async () => {
  const researchId = '66666666-6666-4666-8666-666666666661';
  const createId = '66666666-6666-4666-8666-666666666662';
  const checkId = '66666666-6666-4666-8666-666666666663';
  const bodies = new Map([
    [researchId, Buffer.from(JSON.stringify({
      acceptedSources: [{
        sourceId: evidence.sources[0]!.sourceId,
        title: evidence.sources[0]!.title,
        url: 'https://accepted.example.test/evidence',
      }],
    }))],
    [createId, Buffer.from(JSON.stringify(candidate))],
    [checkId, Buffer.from(JSON.stringify({
      deterministic: { passed: true, contentChecksum: calculateContentChecksum(candidate), findings: [] },
      editorial: { summary: 'Ready.', findings: [] },
    }))],
  ]);
  const client = contextClient(bodies);
  const resolver = new LeaseScopedJobContextResolver(client);
  const dependencies = [
    { artifactId: researchId, revision: 1, kind: 'parsed_output', mediaType: 'application/json', checksum: inputChecksum, action: 'collect_sources' },
    { artifactId: evidence.sources[0]!.snapshotArtifactId, revision: 1, kind: 'source_snapshot', mediaType: 'text/plain', checksum: inputChecksum, action: 'collect_sources', sourceId: evidence.sources[0]!.sourceId },
    { artifactId: createId, revision: 1, kind: 'parsed_output', mediaType: 'application/json', checksum: inputChecksum, action: 'create_content' },
    { artifactId: checkId, revision: 1, kind: 'parsed_output', mediaType: 'application/json', checksum: inputChecksum, action: 'check_content' },
  ];
  const piInput = input('check_content', dependencies);
  const pi = await resolver.pi(piInput);
  const media = await resolver.media(input('produce_assets', dependencies));

  assert.deepEqual(pi.candidate, candidate);
  assert.deepEqual(pi.evidence, evidence);
  assert.equal(media.passedCheck, true);
  assert.equal(media.contentChecksum, calculateContentChecksum(candidate));
});

test('builds Create context from accepted source URLs instead of brief candidates', async () => {
  const researchId = '77777777-7777-4777-8777-777777777771';
  const snapshotId = evidence.sources[0]!.snapshotArtifactId;
  const acceptedUrl = 'https://accepted.example.test/evidence';
  const rejectedBriefUrl = 'https://rejected.example.test/candidate';
  const client = contextClient(new Map([
    [researchId, Buffer.from(JSON.stringify({
      acceptedSources: [{
        sourceId: evidence.sources[0]!.sourceId,
        title: evidence.sources[0]!.title,
        url: acceptedUrl,
      }],
    }))],
  ]));
  const resolver = new LeaseScopedJobContextResolver(client);
  const dependencies = [
    { artifactId: researchId, revision: 1, kind: 'parsed_output', mediaType: 'application/json', checksum: inputChecksum, action: 'collect_sources' },
    { artifactId: snapshotId, revision: 1, kind: 'source_snapshot', mediaType: 'text/plain', checksum: inputChecksum, action: 'collect_sources', sourceId: evidence.sources[0]!.sourceId },
  ];

  const context = await resolver.notebook(input('create_content', dependencies, {
    title: 'Focus',
    sourceUrls: [rejectedBriefUrl],
  }), 'notebook-1');

  assert.deepEqual(context.sourceUrls, [acceptedUrl]);
  assert.deepEqual(context.evidence, evidence);
});

test('executes editorial inference through the local Pi SDK adapter with an abort signal', async () => {
  let observed: Record<string, unknown> | undefined;
  const client = new LocalPiSdkClient({
    provider: 'fixture-provider',
    model: 'fixture-model',
    models: {
      async complete(request) {
        observed = request as unknown as Record<string, unknown>;
        return '```json\n{"summary":"Ready.","findings":[]}\n```';
      },
    },
  });
  const signal = new AbortController().signal;
  const result = await client.check({ candidate, evidence, rubric: 'Check it.', idempotencyKey: 'stable-key', signal });

  assert.deepEqual(result, { summary: 'Ready.', findings: [] });
  assert.equal(observed?.sessionId, 'stable-key');
  assert.ok(observed?.signal instanceof AbortSignal);
});

test('executes media generation through one bounded local command adapter', async () => {
  let commandInput: Record<string, unknown> | undefined;
  const client = new LocalMediaCommandClient({
    command: 'media-provider',
    process: {
      async run(input) {
        commandInput = input as unknown as Record<string, unknown>;
        return {
          stdout: JSON.stringify({
            assets: [{
              kind: 'hero', mediaType: 'image/webp', bytesBase64: Buffer.from('hero').toString('base64'), inputChecksum,
            }],
          }),
          stderr: '',
          exitCode: 0,
        };
      },
    },
  });
  const result = await client.generate({
    content: candidate,
    inputChecksum,
    kinds: ['hero'],
    idempotencyKey: 'stable-media-key',
    signal: new AbortController().signal,
  });

  assert.equal(Buffer.from(result[0]!.bytes).toString(), 'hero');
  assert.match(String(commandInput?.stdin), /stable-media-key/);
  assert.equal(commandInput?.timeoutMs, 120_000);
});

test('force-kills a local provider process that ignores graceful timeout termination', { timeout: 3_000 }, async () => {
  const startedAt = Date.now();
  const result = await runProcess({
    command: process.execPath,
    args: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    timeoutMs: 100,
    signal: new AbortController().signal,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.ok(Date.now() - startedAt < 2_500);
});

const inputChecksum = 'a'.repeat(64);
const evidence = {
  sources: [{
    sourceId: '11111111-1111-4111-8111-111111111111',
    title: 'Evidence',
    snapshotArtifactId: '22222222-2222-4222-8222-222222222222',
  }],
};
const claimId = '55555555-5555-4555-8555-555555555555';
const candidate = {
  title: 'Return to one task',
  takeaway: 'A written next step makes returning easier.',
  action: 'Write one next task and work on it for five minutes.',
  depths: {
    quick: 'Name the next step before switching tasks.',
    core: 'Choose the task that matters now, then define the next visible step.',
    deep: 'Restart friction often comes from deciding what to do again.',
  },
  claims: [{
    claimId,
    statement: 'A concrete next step reduces restart friction.',
    citations: [{
      sourceId: evidence.sources[0]!.sourceId,
      snapshotArtifactId: evidence.sources[0]!.snapshotArtifactId,
      excerpt: 'A defined next action lowers restart friction.',
    }],
  }],
  claimCoverage: [
    { path: 'title' as const, claimIds: [claimId] },
    { path: 'takeaway' as const, claimIds: [claimId] },
    { path: 'action' as const, claimIds: [claimId] },
    { path: 'depths.quick' as const, claimIds: [claimId] },
    { path: 'depths.core' as const, claimIds: [claimId] },
    { path: 'depths.deep' as const, claimIds: [claimId] },
  ],
};

function input(
  action: 'collect_sources' | 'create_content' | 'check_content' | 'produce_assets',
  dependencies: unknown[] = [],
  brief: Record<string, unknown> = { title: 'Focus' },
) {
  return {
    action,
    idempotencyKey: 'runtime-test',
    job: {
      jobId: '33333333-3333-4333-8333-333333333333',
      packageId: '44444444-4444-4444-8444-444444444444',
      stage: action === 'collect_sources' ? 'research' : action === 'create_content' ? 'create' : action === 'check_content' ? 'check' : 'produce_assets',
      claimedBy: 'runtime-test-worker',
      claimedAt: '2026-07-13T10:00:00.000Z',
      leaseExpiresAt: '2026-07-13T10:02:00.000Z',
      executionDeadlineAt: '2026-07-13T10:05:00.000Z',
      attempt: 1,
      revision: 1,
      input: { brief, dependencies },
    },
    signal: new AbortController().signal,
  } as const;
}

function contextClient(bodies: Map<string, Uint8Array>): WorkerEngineClient {
  return {
    async claim() { return null; },
    async heartbeat() { return { kind: 'continue' }; },
    async readArtifact(_job, artifactId) {
      const body = bodies.get(artifactId);
      if (!body) throw new Error(`missing ${artifactId}`);
      return { body, mediaType: 'application/json' };
    },
    async prepareArtifact() { throw new Error('not used'); },
    async uploadArtifact() { throw new Error('not used'); },
    async completeArtifact() { throw new Error('not used'); },
    async reportResult() { throw new Error('not used'); },
    async runDelivery() { throw new Error('not used'); },
  };
}
