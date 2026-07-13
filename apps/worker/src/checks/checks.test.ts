import assert from 'node:assert/strict';
import test from 'node:test';

import { runDeterministicChecks, type ContentCandidate } from './deterministic.js';
import { parseEditorialCheck, requiresEditorialFailure } from './editorial.js';
import { MediaProviderAdapter, type MediaClient } from '../providers/media.js';
import type { ProviderExecutionInput } from '../providers/types.js';

const evidence = {
  sources: [{
    sourceId: '11111111-1111-4111-8111-111111111111',
    title: 'Focused work evidence',
    snapshotArtifactId: '22222222-2222-4222-8222-222222222222',
  }],
};

const claimId = '33333333-3333-4333-8333-333333333333';

const candidate: ContentCandidate = {
  title: 'Return to one task',
  takeaway: 'A written next step makes returning easier.',
  action: 'Write one next task on paper and work on it for five minutes.',
  depths: {
    quick: 'Name the next step before you switch tasks.',
    core: 'Choose the task that matters now, then define the next visible step.',
    deep: 'Restart friction often comes from having to decide what to do again.',
  },
  claims: [{
    claimId,
    statement: 'A concrete next step reduces restart friction.',
    citations: [{
      sourceId: '11111111-1111-4111-8111-111111111111',
      snapshotArtifactId: '22222222-2222-4222-8222-222222222222',
      excerpt: 'A defined next action lowers restart friction.',
    }],
  }],
  claimCoverage: [
    { path: 'title', claimIds: [claimId] },
    { path: 'takeaway', claimIds: [claimId] },
    { path: 'action', claimIds: [claimId] },
    { path: 'depths.quick', claimIds: [claimId] },
    { path: 'depths.core', claimIds: [claimId] },
    { path: 'depths.deep', claimIds: [claimId] },
  ],
};

test('deterministic checks reject placeholders, repeated depths, and ungrounded citations', () => {
  const report = runDeterministicChecks({
    candidate: {
      ...candidate,
      depths: { quick: 'TODO', core: 'TODO', deep: candidate.depths.deep },
      claims: [{
        claimId,
        statement: 'A claim',
        citations: [{
          sourceId: '22222222-2222-4222-8222-222222222222',
          snapshotArtifactId: '44444444-4444-4444-8444-444444444444',
          excerpt: '',
        }],
      }],
    },
    evidence,
  });

  assert.equal(report.passed, false);
  assert.deepEqual(report.findings.map(({ code }) => code).sort(), [
    'citation-excerpt',
    'citation-source',
    'duplicate-depth',
    'placeholder',
  ]);
});

test('deterministic checks reject empty and incomplete learner claim inventories', () => {
  const empty = runDeterministicChecks({
    candidate: { ...candidate, claims: [], claimCoverage: [] },
    evidence,
  });
  assert.equal(empty.passed, false);
  assert.ok(empty.findings.some(({ code }) => code === 'claim-inventory'));

  const incomplete = runDeterministicChecks({
    candidate: { ...candidate, claimCoverage: candidate.claimCoverage.slice(1) },
    evidence,
  });
  assert.equal(incomplete.passed, false);
  assert.ok(incomplete.findings.some(({ code }) => code === 'claim-coverage'));
});

test('editorial parsing uses only critical, major, and minor severities', () => {
  const report = parseEditorialCheck({
    findings: [{ code: 'unsupported-claim', severity: 'major', message: 'No source supports this.' }],
    summary: 'Needs revision.',
  });

  assert.equal(requiresEditorialFailure(report), true);
  assert.equal(report.findings[0]?.blocking, true);
  assert.throws(() => parseEditorialCheck({ findings: [{ code: 'tone', severity: 'warning', message: 'No.' }], summary: 'No.' }), /severity/i);
});

test('media requires a passed check and records the current content checksum on every asset', async () => {
  const calls: unknown[] = [];
  const client: MediaClient = {
    async generate(request) {
      calls.push(request);
      return [{ kind: 'hero', mediaType: 'image/webp', bytes: Buffer.from('asset'), inputChecksum: request.inputChecksum }];
    },
  };
  const provider = new MediaProviderAdapter({
    client,
    context: async () => ({ passedCheck: true, content: candidate, contentChecksum: checksum }),
    kinds: ['hero'],
  });

  const result = await provider.execute(mediaInput());

  assert.equal(result.kind, 'success');
  if (result.kind !== 'success') return;
  assert.equal(result.inputChecksum, checksum);
  assert.equal((result.parsedOutput as { assets: Array<{ inputChecksum: string }> }).assets[0]?.inputChecksum, checksum);
  assert.equal((calls[0] as { idempotencyKey: string }).idempotencyKey, 'operation_fixture');
  assert.deepEqual((calls[0] as { kinds: string[] }).kinds, ['hero']);
});

test('media rejects a failed check or an asset bound to a different content checksum', async () => {
  const failedCheckProvider = new MediaProviderAdapter({
    client: { async generate() { throw new Error('must not run'); } },
    context: async () => ({ passedCheck: false, content: candidate, contentChecksum: checksum }),
  });
  await assert.rejects(() => failedCheckProvider.execute(mediaInput()), /media_check_required/);

  const mismatchProvider = new MediaProviderAdapter({
    client: {
      async generate() {
        return [{ kind: 'hero', mediaType: 'image/webp', bytes: Buffer.from('asset'), inputChecksum: otherChecksum }];
      },
    },
    context: async () => ({ passedCheck: true, content: candidate, contentChecksum: checksum }),
    kinds: ['hero'],
  });
  await assert.rejects(() => mismatchProvider.execute(mediaInput()), /media_input_checksum_mismatch/);
});

const checksum = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const otherChecksum = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function mediaInput(): ProviderExecutionInput {
  return {
    action: 'produce_assets',
    idempotencyKey: 'operation_fixture',
    job: {
      jobId: '33333333-3333-4333-8333-333333333333',
      packageId: '44444444-4444-4444-8444-444444444444',
      stage: 'produce_assets',
      claimedBy: 'test-worker',
      claimedAt: '2026-07-13T10:00:00.000Z',
      leaseExpiresAt: '2026-07-13T10:02:00.000Z',
      executionDeadlineAt: '2026-07-13T10:05:00.000Z',
      attempt: 1,
      revision: 1,
      input: { brief: {}, dependencies: [] },
    },
    signal: new AbortController().signal,
  };
}
