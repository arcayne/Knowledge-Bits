import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PiEditorialProvider, type PiSdkClient } from './pi.js';
import type { ProviderExecutionInput } from './types.js';

test('Pi receives only candidate, evidence, and rubric and records editorial provenance', async () => {
  let request: Record<string, unknown> | undefined;
  const provider = new PiEditorialProvider({
    client: {
      async check(input) {
        request = input as unknown as Record<string, unknown>;
        return JSON.parse(await readFile(new URL('./fixtures/pi-editorial.json', import.meta.url), 'utf8'));
      },
    },
    context: async () => ({ candidate, evidence, rubric: 'Check source faithfulness and practical value.' }),
  });

  const result = await provider.execute(input());

  assert.equal(result.kind, 'success');
  assert.deepEqual(Object.keys(request ?? {}).sort(), ['candidate', 'evidence', 'rubric']);
  if (result.kind !== 'success') return;
  const report = result.executionReport as { promptVersion: string; provider: string; renderedPrompt: string };
  assert.equal(report.promptVersion, 'editorial-check.v1');
  assert.equal(report.provider, 'pi');
  assert.match(report.renderedPrompt, /Check source faithfulness/);
});

test('Pi blocks critical and unsupported-claim findings without a rewrite or scheduling interface', async () => {
  const client: PiSdkClient = {
    async check() {
      return {
        findings: [
          { code: 'unsupported-claim', severity: 'major', message: 'The claim has no usable source.' },
          { code: 'tone', severity: 'critical', message: 'The draft makes a harmful assertion.' },
        ],
        summary: 'Not ready.',
      };
    },
  };
  const provider = new PiEditorialProvider({
    client,
    context: async () => ({ candidate, evidence, rubric: 'Evaluate the candidate.' }),
  });

  await assert.rejects(() => provider.execute(input()), /editorial_check_failed/);
  assert.equal('rewrite' in client, false);
  assert.equal('schedule' in client, false);
});

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

function input(): ProviderExecutionInput {
  return {
    action: 'check_content',
    idempotencyKey: 'operation_fixture',
    job: {
      jobId: '33333333-3333-4333-8333-333333333333',
      packageId: '44444444-4444-4444-8444-444444444444',
      stage: 'check',
      claimedBy: 'test-worker',
      claimedAt: '2026-07-13T10:00:00.000Z',
      leaseExpiresAt: '2026-07-13T10:02:00.000Z',
      attempt: 1,
      revision: 1,
    },
    signal: new AbortController().signal,
  };
}
