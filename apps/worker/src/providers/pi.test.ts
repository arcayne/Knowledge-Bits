import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PiEditorialProvider, type PiSdkClient } from './pi.js';
import type { ProviderExecutionInput } from './types.js';
import { canonicalJsonBytes } from '../recipes/file-registry.js';
import { LocalPiSdkClient, type PiModelsAdapter } from '../runtime.js';

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
    'candidate', 'evidence', 'idempotencyKey', 'rubric', 'signal',
  ]);
  if (result.kind !== 'success') return;
  const report = result.executionReport as { promptVersion: string; provider: string; renderedPrompt: string };
  assert.equal(report.promptVersion, 'editorial-check.v1');
  assert.equal(report.provider, 'pi');
  assert.match(report.renderedPrompt, /Check source faithfulness/);
});

test('legacy PI sends the exact pre-1.1.0 JSON request shape', async () => {
  let userPrompt: string | undefined;
  const models: PiModelsAdapter = {
    async complete(input) {
      userPrompt = input.userPrompt;
      return JSON.stringify({ summary: 'Ready.', findings: [] });
    },
  };
  const client = new LocalPiSdkClient({ provider: 'fixture', model: 'fixture', models });

  await client.check({
    candidate,
    evidence,
    rubric: 'Check source faithfulness and practical value.',
    idempotencyKey: 'operation_fixture',
    signal: new AbortController().signal,
  });

  assert.equal(userPrompt, JSON.stringify({
    candidate,
    evidence,
    rubric: 'Check source faithfulness and practical value.',
  }));
});

test('runs Story and Playbook editorial QA from the resolved rubric with immutable prompt evidence', async () => {
  let request: Record<string, unknown> | undefined;
  const editorialRecipe = resolvedRecipe('nuglet.qa.editorial', {
    id: 'nuglet.qa.editorial',
    version: '1.0.0',
    status: 'approved',
    instructions: ['Reject unsupported claims and mismatched actions.'],
    validationChecks: ['Story and Playbook must teach the same central idea.'],
  });
  const semantic = await semanticCandidate();
  const provider = new PiEditorialProvider({
    client: {
      async check(input) {
        request = input as unknown as Record<string, unknown>;
        return JSON.parse(await readFile(new URL('./fixtures/pi-editorial.json', import.meta.url), 'utf8'));
      },
    },
    context: async () => ({
      candidate: semantic,
      evidence,
      rubric: 'Check source faithfulness and practical value.',
      generationPlan: { schemaVersion: '1.1.0' } as never,
      resolvedRecipes: { editorialQa: editorialRecipe },
    }),
    model: 'pi-fixture-model',
  });

  const result = await provider.execute(input());

  assert.equal(result.kind, 'success');
  if (result.kind !== 'success') return;
  const renderedPrompt = String(request?.renderedPrompt);
  assert.match(String(request?.rubric), /Reject unsupported claims and mismatched actions/);
  assert.match(renderedPrompt, /Story and Playbook must teach the same central idea/);
  assert.match(renderedPrompt, /"schemaVersion":"1\.1\.0"/);
  assert.deepEqual(result.supportArtifacts?.map(({ kind }) => kind), [
    'generation.recipe.snapshot',
    'generation.prompt.rendered',
  ]);
  assert.deepEqual(result.supportArtifacts?.[0]?.body, editorialRecipe.canonicalBytes);
  assert.equal(Buffer.from(result.supportArtifacts?.[1]?.body ?? []).toString('utf8'), renderedPrompt);
  const report = result.executionReport as { promptVersion: string; renderedPrompt: string };
  assert.equal(report.promptVersion, 'nuglet.qa.editorial@1.0.0');
  assert.equal(report.renderedPrompt, renderedPrompt);
});

test('Story and Playbook Pi keeps valid blocking findings as provenance-backed QA success', async () => {
  const editorialRecipe = resolvedRecipe('nuglet.qa.editorial', {
    id: 'nuglet.qa.editorial',
    version: '1.0.0',
    status: 'approved',
    instructions: ['Flag claims that need stronger support.'],
    validationChecks: ['Keep findings specific.'],
  });
  const provider = new PiEditorialProvider({
    client: {
      async check() {
        return {
          summary: 'Review before publishing.',
          findings: [{
            code: 'unsupported-claim',
            severity: 'major',
            message: 'This claim needs a stronger source.',
          }],
        };
      },
    },
    context: async () => ({
      candidate: await semanticCandidate(),
      evidence,
      rubric: 'Check source faithfulness and practical value.',
      generationPlan: { schemaVersion: '1.1.0' } as never,
      resolvedRecipes: { editorialQa: editorialRecipe },
    }),
  });

  const result = await provider.execute(input());

  assert.equal(result.kind, 'success');
  if (result.kind !== 'success') return;
  assert.deepEqual((result.parsedOutput as { editorial: unknown }).editorial, {
    summary: 'Review before publishing.',
    findings: [{
      code: 'unsupported-claim',
      severity: 'major',
      blocking: true,
      message: 'This claim needs a stronger source.',
    }],
  });
  assert.deepEqual(result.supportArtifacts?.map((artifact) => artifact.kind), [
    'generation.recipe.snapshot',
    'generation.prompt.rendered',
  ]);
});

test('Pi rejects malformed editorial responses instead of converting them to warnings', async () => {
  const provider = new PiEditorialProvider({
    client: { async check() { return { summary: 'Malformed.', findings: [{}] }; } },
    context: async () => ({ candidate, evidence, rubric: 'Evaluate the candidate.' }),
  });

  await assert.rejects(() => provider.execute(input()), /Editorial finding requires code and message/);
});

test('Pi persists blocking editorial findings as successful QA without a rewrite or scheduling interface', async () => {
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

  const result = await provider.execute(input());

  assert.equal(result.kind, 'success');
  if (result.kind !== 'success') return;
  assert.deepEqual(JSON.parse(Buffer.from(result.rawResponse).toString('utf8')), {
    findings: [
      { code: 'unsupported-claim', severity: 'major', message: 'The claim has no usable source.' },
      { code: 'tone', severity: 'critical', message: 'The draft makes a harmful assertion.' },
    ],
    summary: 'Not ready.',
  });
  const parsed = result.parsedOutput as {
    deterministic: { passed: boolean; contentChecksum: string; findings: unknown[] };
    editorial: unknown;
  };
  assert.deepEqual(parsed.deterministic, {
    passed: true,
    contentChecksum: parsed.deterministic.contentChecksum,
    findings: [],
  });
  assert.match(parsed.deterministic.contentChecksum, /^[a-f0-9]{64}$/);
  assert.deepEqual(parsed.editorial, {
    summary: 'Not ready.',
    findings: [
      {
        code: 'unsupported-claim',
        severity: 'major',
        blocking: true,
        message: 'The claim has no usable source.',
      },
      {
        code: 'tone',
        severity: 'critical',
        blocking: true,
        message: 'The draft makes a harmful assertion.',
      },
    ],
  });
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

async function semanticCandidate() {
  const fixture = JSON.parse(await readFile(
    new URL('./fixtures/notebooklm-story-playbook.json', import.meta.url),
    'utf8',
  )) as { answer: { payload: { claims: Array<{ citations: Array<Record<string, unknown>> }> } } };
  const value = structuredClone(fixture.answer);
  for (const claim of value.payload.claims) {
    claim.citations = claim.citations.map((citation) => ({
      ...citation,
      snapshotArtifactId: evidence.sources[0]!.snapshotArtifactId,
    }));
  }
  return value as never;
}
