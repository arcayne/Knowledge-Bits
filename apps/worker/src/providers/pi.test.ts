import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PiEditorialProvider, type PiSdkClient } from './pi.js';
import type { ProviderExecutionInput } from './types.js';
import { canonicalJsonBytes } from '../recipes/file-registry.js';

test('Pi receives only review context and execution controls and records editorial provenance', async () => {
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
  assert.deepEqual(Object.keys(request ?? {}).sort(), [
    'candidate', 'evidence', 'idempotencyKey', 'renderedPrompt', 'rubric', 'signal',
  ]);
  if (result.kind !== 'success') return;
  const report = result.executionReport as { promptVersion: string; provider: string; renderedPrompt: string };
  assert.equal(report.promptVersion, 'editorial-check.v1');
  assert.equal(report.provider, 'pi');
  assert.match(report.renderedPrompt, /Check source faithfulness/);
});

test('sends the trusted editorial recipe in the exact Pi prompt and emits one immutable artifact pair', async () => {
  let request: Record<string, unknown> | undefined;
  const editorialRecipe = resolvedRecipe('nuglet.qa.editorial', {
    id: 'nuglet.qa.editorial',
    version: '1.0.0',
    status: 'approved',
    rubric: ['Reject unsupported claims.'],
  });
  const provider = new PiEditorialProvider({
    model: 'pi-test-model',
    client: {
      async check(input) {
        request = input as unknown as Record<string, unknown>;
        return JSON.parse(await readFile(new URL('./fixtures/pi-editorial.json', import.meta.url), 'utf8'));
      },
    },
    context: async () => ({
      candidate,
      evidence,
      rubric: 'Check source faithfulness and practical value.',
      generationPlan: {} as never,
      resolvedRecipes: { editorialQa: editorialRecipe },
    }),
  });

  const result = await provider.execute(input());

  assert.equal(result.kind, 'success');
  if (result.kind !== 'success') return;
  const renderedPrompt = String(request?.renderedPrompt);
  assert.match(renderedPrompt, /Reject unsupported claims/);
  assert.deepEqual(result.supportArtifacts?.map(({ kind }) => kind), [
    'generation.recipe.snapshot',
    'generation.prompt.rendered',
  ]);
  assert.deepEqual(result.supportArtifacts?.[0]?.body, editorialRecipe.canonicalBytes);
  assert.equal(Buffer.from(result.supportArtifacts?.[1]?.body ?? []).toString('utf8'), renderedPrompt);
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
  sources: [{
    sourceId: '11111111-1111-4111-8111-111111111111',
    title: 'Focused work evidence',
    snapshotArtifactId: '22222222-2222-4222-8222-222222222222',
  }],
};

const claimId = '55555555-5555-4555-8555-555555555555';
const candidate = {
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
      executionDeadlineAt: '2026-07-13T10:05:00.000Z',
      attempt: 1,
      revision: 1,
      input: { brief: {}, dependencies: [] },
    },
    signal: new AbortController().signal,
  };
}

function resolvedRecipe(id: string, value: Record<string, unknown>) {
  const canonicalBytes = canonicalJsonBytes(value);
  return {
    id,
    version: '1.0.0',
    checksum: `sha256:${createHash('sha256').update(canonicalBytes).digest('hex')}`,
    canonicalBytes,
    value,
  };
}
