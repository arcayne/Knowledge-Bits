import assert from 'node:assert/strict';
import test from 'node:test';

import { composeWorkerProviders, type ProviderRuntime } from './runtime.js';

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

const inputChecksum = 'a'.repeat(64);
const evidence = {
  sources: [{ sourceId: '11111111-1111-4111-8111-111111111111', title: 'Evidence' }],
};
const candidate = {
  title: 'Return to one task',
  takeaway: 'A written next step makes returning easier.',
  action: 'Write one next task and work on it for five minutes.',
  depths: {
    quick: 'Name the next step before switching tasks.',
    core: 'Choose the task that matters now, then define the next visible step.',
    deep: 'Restart friction often comes from deciding what to do again.',
  },
  claims: [{ statement: 'A concrete next step reduces restart friction.', citations: [{ sourceId: evidence.sources[0]!.sourceId, excerpt: 'A defined next action lowers restart friction.' }] }],
};

function input(action: 'collect_sources' | 'create_content' | 'check_content' | 'produce_assets') {
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
      attempt: 1,
      revision: 1,
    },
    signal: new AbortController().signal,
  } as const;
}
