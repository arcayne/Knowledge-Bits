import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { runDeterministicChecks, type ContentCandidate } from './deterministic.js';

const sourceId = '11111111-1111-4111-8111-111111111111';
const snapshotArtifactId = '55555555-5555-4555-8555-555555555555';
const evidence = {
  sources: [{ sourceId, title: 'Focused work evidence', snapshotArtifactId }],
};

test('accepts a grounded semantic Story and Playbook draft', async () => {
  const report = runDeterministicChecks({ candidate: await semanticCandidate(), evidence });

  assert.equal(report.passed, true, JSON.stringify(report.findings));
  assert.deepEqual(report.findings, []);
});

test('reports missing narrative beats and unbound factual Story blocks', async () => {
  const candidate = await semanticCandidate();
  const story = semanticPayload(candidate).read.story;
  story.blocks = story.blocks
    .filter(({ type }) => type !== 'turning_point')
    .map((block) => block.type === 'evidence' ? { ...block, claimRefs: [] } : block);

  const report = runDeterministicChecks({ candidate, evidence });

  assert.equal(report.passed, false);
  assert.ok(report.findings.some(({ code }) => code === 'story-integrity'));
});

test('reports incomplete Playbook structure', async () => {
  const candidate = await semanticCandidate();
  const playbook = semanticPayload(candidate).read.playbook;
  playbook.principle = '';
  playbook.steps = playbook.steps.slice(0, 2);
  playbook.watchOuts = [];

  const report = runDeterministicChecks({ candidate, evidence });

  assert.equal(report.passed, false);
  assert.ok(report.findings.some(({ code }) => code === 'playbook-structure'));
});

test('reports cross-format drift from the shared action', async () => {
  const candidate = await semanticCandidate();
  const payload = semanticPayload(candidate);
  payload.read.playbook.action = 'A different action.';

  const report = runDeterministicChecks({ candidate, evidence });

  assert.equal(report.passed, false);
  assert.ok(report.findings.some(({ code }) => code === 'cross-format-consistency'));
});

test('reports terminology drift when the other shared values still match', async () => {
  const candidate = await semanticCandidate();
  const payload = semanticPayload(candidate);
  payload.read.playbook = JSON.parse(
    JSON.stringify(payload.read.playbook).replaceAll('restart marker', 'resume cue'),
  );

  const report = runDeterministicChecks({ candidate, evidence });

  assert.equal(report.passed, false);
  assert.ok(report.findings.some(({ code }) => code === 'cross-format-consistency'));
});

test('reports normalized Story and Playbook duplication', async () => {
  const candidate = await semanticCandidate();
  const payload = semanticPayload(candidate);
  const duplicate = [
    payload.learning.centralIdea,
    payload.learning.oneLineToKeep,
    payload.learning.action.instruction,
    'Use the same restart marker in every section.',
  ].join(' ');
  payload.read.story.blocks = payload.read.story.blocks.map((block) => ({ ...block, text: duplicate }));
  payload.read.playbook.principle = duplicate;
  payload.read.playbook.whyItMatters = duplicate;
  payload.read.playbook.steps = payload.read.playbook.steps.map((step) => ({
    ...step,
    title: duplicate,
    body: duplicate,
  }));
  payload.read.playbook.example = { ...payload.read.playbook.example, title: duplicate, body: duplicate };
  payload.read.playbook.watchOuts = [duplicate];

  const report = runDeterministicChecks({ candidate, evidence });

  assert.equal(report.passed, false);
  assert.ok(report.findings.some(({ code }) => code === 'cross-format-consistency'));
});

test('reports a malformed three-question challenge', async () => {
  const candidate = await semanticCandidate();
  semanticPayload(candidate).quiz.questions = semanticPayload(candidate).quiz.questions.slice(0, 2);

  const report = runDeterministicChecks({ candidate, evidence });

  assert.equal(report.passed, false);
  assert.ok(report.findings.some(({ code }) => code === 'challenge-shape'));
});

test('reports incomplete semantic claim coverage', async () => {
  const candidate = await semanticCandidate();
  const payload = semanticPayload(candidate);
  payload.claimCoverage = payload.claimCoverage.filter(({ path }) => path !== 'read.playbook');
  payload.read.playbook.steps[0]!.claimRefs = ['99999999-9999-4999-8999-999999999999'];

  const report = runDeterministicChecks({ candidate, evidence });

  assert.equal(report.passed, false);
  assert.ok(report.findings.some(({ code }) => code === 'claim-coverage'));
});

test('allows omitted claim coverage for learner paths without explicit claim references', async () => {
  const candidate = await semanticCandidate();
  const payload = semanticPayload(candidate);
  const requiredByNestedReferences = new Set(['read.story', 'read.playbook', 'visual', 'quiz']);
  payload.claimCoverage = payload.claimCoverage.filter(({ path }) => requiredByNestedReferences.has(path));

  const report = runDeterministicChecks({ candidate, evidence });

  assert.equal(report.findings.some(({ code }) => code === 'claim-coverage'), false);
});

test('preserves legacy claim-coverage messages and cardinality', () => {
  const candidate = legacyCandidate();
  candidate.claimCoverage = [
    { path: 'title', claimIds: [legacyClaimId] },
    { path: 'title', claimIds: [legacyClaimId] },
    { path: 'takeaway', claimIds: [] },
    { path: 'action', claimIds: ['99999999-9999-4999-8999-999999999999'] },
    { path: 'depths.quick', claimIds: [legacyClaimId] },
    { path: 'depths.core', claimIds: [legacyClaimId] },
  ];

  const report = runDeterministicChecks({ candidate, evidence });

  assert.deepEqual(report.findings.filter(({ code }) => code === 'claim-coverage'), [
    { code: 'claim-coverage', message: 'Learner claim coverage paths must be unique.' },
    { code: 'claim-coverage', message: 'Learner field takeaway requires valid claim coverage.' },
    { code: 'claim-coverage', message: 'Learner field action requires valid claim coverage.' },
    { code: 'claim-coverage', message: 'Learner field depths.deep requires valid claim coverage.' },
  ]);
});

async function semanticCandidate(): Promise<ContentCandidate> {
  const fixture = JSON.parse(await readFile(
    new URL('../providers/fixtures/notebooklm-story-playbook.json', import.meta.url),
    'utf8',
  )) as { answer: Record<string, unknown> };
  const candidate = structuredClone(fixture.answer) as unknown as ContentCandidate;
  for (const claim of semanticPayload(candidate).claims) {
    claim.citations = claim.citations.map((citation) => ({ ...citation, snapshotArtifactId }));
  }
  return candidate;
}

function semanticPayload(candidate: ContentCandidate) {
  return (candidate as unknown as {
    payload: {
      learning: {
        centralIdea: string;
        oneLineToKeep: string;
        terminology: string[];
        action: { instruction: string };
      };
      read: {
        story: { blocks: Array<{ type: string; text: string; claimRefs: string[] }> };
        playbook: {
          principle: string;
          whyItMatters: string;
          steps: Array<{ id: string; title: string; body: string; claimRefs: string[] }>;
          example: { title: string; body: string; claimRefs: string[] };
          watchOuts: string[];
          action: string;
        };
      };
      quiz: { questions: Array<Record<string, unknown>> };
      claims: Array<{ claimId: string; citations: Array<{ sourceId: string; excerpt: string; snapshotArtifactId?: string }> }>;
      claimCoverage: Array<{ path: string; claimIds: string[] }>;
    };
  }).payload;
}

const legacyClaimId = '66666666-6666-4666-8666-666666666666';

function legacyCandidate(): Extract<ContentCandidate, { title: string }> {
  return {
    title: 'Return to one task',
    takeaway: 'A written next step makes returning easier.',
    action: 'Write one next task on paper and work on it for five minutes.',
    depths: {
      quick: 'Name the next step before you switch tasks.',
      core: 'Choose the task that matters now, then define the next visible step.',
      deep: 'Restart friction often comes from having to decide what to do again.',
    },
    claims: [{
      claimId: legacyClaimId,
      statement: 'A concrete next step reduces restart friction.',
      citations: [{ sourceId, snapshotArtifactId, excerpt: 'A defined next action lowers restart friction.' }],
    }],
    claimCoverage: [],
  };
}
