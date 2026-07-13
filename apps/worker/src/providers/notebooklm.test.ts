import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { NotebookLmProvider, type NotebookLmProcess } from './notebooklm.js';
import type { ProviderExecutionInput } from './types.js';

const sourceId = '11111111-1111-4111-8111-111111111111';

test('NotebookLM fixtures contain no credential names or absolute home paths', async () => {
  const fixtureUrls = [
    new URL('./fixtures/notebooklm-research.json', import.meta.url),
    new URL('./fixtures/notebooklm-create.json', import.meta.url),
    new URL('./fixtures/pi-editorial.json', import.meta.url),
  ];
  const fixtures = await Promise.all(fixtureUrls.map(async (url) => JSON.parse(await readFile(url, 'utf8'))));
  const forbidden = /(?:api[_-]?key|authorization|bearer|cookie|password|secret|session|token|\/Users\/|\/home\/|[A-Z]:\\Users\\)/i;

  for (const fixture of fixtures) {
    assert.equal(forbidden.test(JSON.stringify(fixture)), false);
    assert.equal(forbidden.test(JSON.stringify(keysOf(fixture))), false);
  }
});

test('discovers the exact NotebookLM CLI version and records prompt provenance', async () => {
  const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
  const provider = new NotebookLmProvider({
    sourceVerifier: fakeSourceVerifier,
    process: processWith(calls, [
      { stdout: 'nlm 0.9.4\n', stderr: '', exitCode: 0 },
      { stdout: await fixture('notebooklm-research.json'), stderr: '', exitCode: 0 },
    ]),
    context: async () => ({
      notebookId: 'notebook_fixture_01',
      sourceUrls: [],
      topic: 'returning to focused work',
    }),
  });

  const result = await provider.execute(input('collect_sources'));

  assert.equal(result.kind, 'success');
  if (result.kind !== 'success') return;
  const report = result.executionReport as { cliVersion: string; promptVersion: string; renderedPrompt: string };
  assert.deepEqual(calls[0]?.args, ['--version']);
  assert.equal(report.cliVersion, 'nlm 0.9.4');
  assert.equal(report.promptVersion, 'notebooklm-research.v1');
  assert.match(report.renderedPrompt, /returning to focused work/);
  const output = result.parsedOutput as { acceptedSources: Array<{ sourceId: string }> };
  assert.equal(output.acceptedSources[0]?.sourceId, sourceId);
  assert.equal(result.assets?.[0]?.kind, 'source_snapshot');
});

test('classifies a provider cooldown without attempting a structured repair', async () => {
  const provider = new NotebookLmProvider({
    sourceVerifier: fakeSourceVerifier,
    now: () => new Date('2026-07-13T10:00:00.000Z'),
    process: processWith([], [
      { stdout: 'nlm 0.9.4\n', stderr: '', exitCode: 0 },
      { stdout: '', stderr: 'rate limit, retry after 120 seconds', exitCode: 75 },
    ]),
    context: async () => ({ notebookId: 'notebook_fixture_01', sourceUrls: [], topic: 'focus' }),
  });

  await assert.rejects(
    () => provider.execute(input('collect_sources')),
    (error: unknown) => error instanceof Error && error.message === 'notebooklm_cooldown' && 'retryAt' in error
      && (error as { retryAt: string }).retryAt === '2026-07-13T10:02:00.000Z',
  );
});

test('uses exactly one repair request for malformed structured output', async () => {
  const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
  const provider = new NotebookLmProvider({
    sourceVerifier: fakeSourceVerifier,
    process: processWith(calls, [
      { stdout: 'nlm 0.9.4\n', stderr: '', exitCode: 0 },
      { stdout: 'not json', stderr: '', exitCode: 0 },
      { stdout: await fixture('notebooklm-research.json'), stderr: '', exitCode: 0 },
    ]),
    context: async () => ({ notebookId: 'notebook_fixture_01', sourceUrls: [], topic: 'focus' }),
  });

  const result = await provider.execute(input('collect_sources'));

  assert.equal(result.kind, 'success');
  assert.equal(calls.filter(({ args }) => args.includes('--repair-json')).length, 1);
});

test('rejects malformed structured output after its one repair attempt', async () => {
  const provider = new NotebookLmProvider({
    sourceVerifier: fakeSourceVerifier,
    process: processWith([], [
      { stdout: 'nlm 0.9.4\n', stderr: '', exitCode: 0 },
      { stdout: 'not json', stderr: '', exitCode: 0 },
      { stdout: 'still not json', stderr: '', exitCode: 0 },
    ]),
    context: async () => ({ notebookId: 'notebook_fixture_01', sourceUrls: [], topic: 'focus' }),
  });

  await assert.rejects(() => provider.execute(input('collect_sources')), /notebooklm_malformed_output/);
});

test('rejects citations that do not resolve to a returned source', async () => {
  const provider = new NotebookLmProvider({
    sourceVerifier: fakeSourceVerifier,
    process: processWith([], [
      { stdout: 'nlm 0.9.4\\n', stderr: '', exitCode: 0 },
      {
        stdout: JSON.stringify({
          conversationId: 'conversation_fixture_01',
          answer: { claims: [{ statement: 'A claim', citations: [{ sourceId: '22222222-2222-4222-8222-222222222222', excerpt: 'proof' }] }], sources: [] },
        }),
        stderr: '',
        exitCode: 0,
      },
      { stdout: 'still not json', stderr: '', exitCode: 0 },
    ]),
    context: async () => ({ notebookId: 'notebook_fixture_01', sourceUrls: [], topic: 'focus' }),
  });

  await assert.rejects(() => provider.execute(input('collect_sources')), /citation.*source/i);
});

test('classifies process timeouts as a typed wait', async () => {
  const timeoutProcess: NotebookLmProcess = {
    async run() {
      return { stdout: '', stderr: '', exitCode: null, timedOut: true };
    },
  };
  const provider = new NotebookLmProvider({
    sourceVerifier: fakeSourceVerifier,
    now: () => new Date('2026-07-13T10:00:00.000Z'),
    process: timeoutProcess,
    context: async () => ({ notebookId: 'notebook_fixture_01', sourceUrls: [], topic: 'focus' }),
  });
  await assert.rejects(() => provider.execute(input('collect_sources')), /notebooklm_timeout/);
});

test('allows a fourth revision because revision policy belongs to the state machine', async () => {
  const provider = new NotebookLmProvider({
    sourceVerifier: fakeSourceVerifier,
    process: processWith([], [
      { stdout: 'nlm 0.9.4\n', stderr: '', exitCode: 0 },
      { stdout: await fixture('notebooklm-create.json'), stderr: '', exitCode: 0 },
    ]),
    context: async () => ({
      notebookId: 'notebook_fixture_01',
      sourceUrls: [],
      topic: 'focus',
      evidence: { sources: [{ sourceId, title: 'Accepted source', snapshotArtifactId: '55555555-5555-4555-8555-555555555555' }] },
    }),
  });
  const result = await provider.execute(input('create_content', 4));

  assert.equal(result.kind, 'success');
  if (result.kind === 'success') {
    const output = result.parsedOutput as { claims: Array<{ citations: Array<{ snapshotArtifactId: string }> }> };
    assert.equal(output.claims[0]?.citations[0]?.snapshotArtifactId, '55555555-5555-4555-8555-555555555555');
  }
});

test('classifies incomplete learner claim coverage as a quality failure at Create', async () => {
  const provider = new NotebookLmProvider({
    sourceVerifier: fakeSourceVerifier,
    process: processWith([], [
      { stdout: 'nlm 0.9.4\n', stderr: '', exitCode: 0 },
      {
        stdout: JSON.stringify({
          conversationId: 'conversation_fixture_01',
          answer: {
            title: 'Incomplete lesson',
            takeaway: 'A takeaway.',
            action: 'An action.',
            depths: { quick: 'Quick.', core: 'Core.', deep: 'Deep.' },
            claims: [],
            claimCoverage: [],
          },
        }),
        stderr: '',
        exitCode: 0,
      },
    ]),
    context: async () => ({
      notebookId: 'notebook_fixture_01',
      sourceUrls: [],
      topic: 'focus',
      evidence: { sources: [{ sourceId, title: 'Accepted source', snapshotArtifactId: '55555555-5555-4555-8555-555555555555' }] },
    }),
  });

  await assert.rejects(
    () => provider.execute(input('create_content')),
    (error: unknown) => error instanceof Error
      && error.message === 'notebooklm_content_invalid'
      && 'needsHumanKind' in error
      && error.needsHumanKind === 'quality',
  );
});

test('does not let a create response authorize citations with its recommended sources', async () => {
  const selfAuthorizedSource = '22222222-2222-4222-8222-222222222222';
  const provider = new NotebookLmProvider({
    sourceVerifier: fakeSourceVerifier,
    process: processWith([], [
      { stdout: 'nlm 0.9.4\n', stderr: '', exitCode: 0 },
      {
        stdout: JSON.stringify({
          conversationId: 'conversation_fixture_01',
          answer: {
            claims: [{ statement: 'An unsupported claim.', citations: [{ sourceId: selfAuthorizedSource, excerpt: 'Invented support.' }] }],
            sources: [{ sourceId: selfAuthorizedSource, title: 'Candidate source' }],
          },
        }),
        stderr: '',
        exitCode: 0,
      },
    ]),
    context: async () => ({
      notebookId: 'notebook_fixture_01',
      sourceUrls: [],
      topic: 'focus',
      evidence: { sources: [{ sourceId, title: 'Accepted source', snapshotArtifactId: '55555555-5555-4555-8555-555555555555' }] },
    }),
  });

  await assert.rejects(() => provider.execute(input('create_content')), /notebooklm_citation_source_missing/);
});

function input(action: ProviderExecutionInput['action'], revision = 1): ProviderExecutionInput {
  return {
    action,
    idempotencyKey: 'operation_fixture',
    job: {
      jobId: '33333333-3333-4333-8333-333333333333',
      packageId: '44444444-4444-4444-8444-444444444444',
      stage: action === 'collect_sources' ? 'research' : 'create',
      claimedBy: 'test-worker',
      claimedAt: '2026-07-13T10:00:00.000Z',
      leaseExpiresAt: '2026-07-13T10:02:00.000Z',
      executionDeadlineAt: '2026-07-13T10:05:00.000Z',
      attempt: 1,
      revision,
      input: { brief: {}, dependencies: [] },
    },
    signal: new AbortController().signal,
  };
}

function processWith(
  calls: Array<{ args: readonly string[]; stdin?: string }>,
  responses: Array<{ stdout: string; stderr: string; exitCode: number | null; timedOut?: boolean }>,
): NotebookLmProcess {
  return {
    async run(command) {
      calls.push({ args: command.args, stdin: command.stdin });
      const response = responses.shift();
      if (!response) throw new Error('Unexpected NotebookLM process invocation');
      return response;
    },
  };
}

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...keysOf(child)]);
}

void sourceId;

const fakeSourceVerifier = {
  async verify(value: unknown) {
    const sources = (value as { sources: Array<{ sourceId: string; title: string; url: string }> }).sources;
    return {
      evidence: {
        acceptedSources: sources.map((source) => ({
          ...source,
          retrievedAt: '2026-07-13T10:00:00.000Z',
          snapshotChecksum: 'a'.repeat(64),
          readability: { passed: true, reason: null },
          credibility: { passed: true, policy: 'fixture-trusted-hosts.v1', reason: null },
        })),
        rejectedSources: [],
        coverageGaps: [],
      },
      snapshots: [{
        kind: 'source_snapshot',
        mediaType: 'text/plain',
        body: Buffer.from('fixture source snapshot'),
        inputChecksum: null,
        provenance: { sourceId: sources[0]?.sourceId },
      }],
    };
  },
};
