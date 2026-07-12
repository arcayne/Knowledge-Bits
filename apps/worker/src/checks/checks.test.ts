import assert from 'node:assert/strict';
import test from 'node:test';

import { runDeterministicChecks } from './deterministic.js';
import { parseEditorialCheck, requiresEditorialFailure } from './editorial.js';
import { MediaProviderAdapter, type MediaClient } from '../providers/media.js';
import type { ProviderExecutionInput } from '../providers/types.js';

const evidence = {
  sources: [{ sourceId: '11111111-1111-4111-8111-111111111111', title: 'Focused work evidence' }],
};

const candidate = {
  title: 'Return to one task',
  takeaway: 'A written next step makes returning easier.',
  action: 'Write one next task on paper and work on it for five minutes.',
  depths: {
    quick: 'Name the next step before you switch tasks.',
    core: 'Choose the task that matters now, then define the next visible step.',
    deep: 'Restart friction often comes from having to decide what to do again.',
  },
  claims: [{ statement: 'A concrete next step reduces restart friction.', citations: [{ sourceId: '11111111-1111-4111-8111-111111111111', excerpt: 'A defined next action lowers restart friction.' }] }],
};

test('deterministic checks reject placeholders, repeated depths, and ungrounded citations', () => {
  const report = runDeterministicChecks({
    candidate: {
      ...candidate,
      depths: { quick: 'TODO', core: 'TODO', deep: candidate.depths.deep },
      claims: [{ statement: 'A claim', citations: [{ sourceId: '22222222-2222-4222-8222-222222222222', excerpt: '' }] }],
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

test('editorial parsing uses only critical, major, and minor severities', () => {
  const report = parseEditorialCheck({
    findings: [{ code: 'unsupported-claim', severity: 'major', message: 'No source supports this.' }],
    summary: 'Needs revision.',
  });

  assert.equal(requiresEditorialFailure(report), true);
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
  });

  const result = await provider.execute(mediaInput());

  assert.equal(result.kind, 'success');
  if (result.kind !== 'success') return;
  assert.equal(result.inputChecksum, checksum);
  assert.equal((result.parsedOutput as { assets: Array<{ inputChecksum: string }> }).assets[0]?.inputChecksum, checksum);
  assert.deepEqual(calls, [{ content: candidate, inputChecksum: checksum, kinds: ['hero', 'infographic', 'audio'] }]);
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
      attempt: 1,
      revision: 1,
    },
    signal: new AbortController().signal,
  };
}
