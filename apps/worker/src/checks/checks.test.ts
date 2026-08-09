import assert from 'node:assert/strict';
import test from 'node:test';

import { runDeterministicChecks, type ContentCandidate } from './deterministic.js';
import { parseEditorialCheck, requiresEditorialFailure } from './editorial.js';

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

test('deterministic checks allow ordinary discussion of competitors', () => {
  const report = runDeterministicChecks({
    candidate: {
      ...candidate,
      depths: {
        ...candidate.depths,
        deep: 'Compare the offer with a competitor before choosing the clearest next step.',
      },
    },
    evidence,
  });

  assert.equal(report.findings.some(({ code }) => code === 'placeholder'), false);
});

test('deterministic checks require a hashtagged social post for Story Playbook content', () => {
  const basePayload = {
    identity: {
      locale: 'en-GB',
      topic: { label: 'focus', categoryId: null },
      tags: ['focus'],
      title: 'Return to one task',
      deck: 'Make returning easier.',
      slugSuggestion: 'return-to-one-task',
    },
    learning: {
      centralIdea: 'A written next step makes returning easier.',
      whyItMatters: 'Restarting is easier when the next move is visible.',
      oneLineToKeep: 'Leave yourself a visible next step.',
      terminology: ['restart friction'],
      action: { label: 'Write the next step', instruction: 'Write one next task on paper.' },
    },
    socialPost: { platform: 'cross-platform', text: 'Return to your next step. #Focus #WorkHabits #Productivity' },
    read: {
      story: {
        title: 'The interruption',
        estimatedMinutes: 2,
        blocks: [
          { type: 'opening', text: 'The interruption arrived mid-task.', claimRefs: [] },
          { type: 'evidence', text: 'A visible next step reduces restart friction.', claimRefs: [claimId] },
          { type: 'turning_point', text: 'The next move was already written.', claimRefs: [claimId] },
          { type: 'practical_bridge', text: 'Write the next step before switching.', claimRefs: [claimId] },
        ],
      },
      playbook: {
        title: 'Leave a restart cue',
        estimatedMinutes: 2,
        principle: 'Make the next move visible.',
        whyItMatters: 'A visible cue lowers the cost of returning.',
        steps: [
          { id: 'one', title: 'Pause', body: 'Pause before switching.', claimRefs: [claimId] },
          { id: 'two', title: 'Name', body: 'Name the next move.', claimRefs: [claimId] },
          { id: 'three', title: 'Return', body: 'Use the cue when you return.', claimRefs: [claimId] },
        ],
        example: { title: 'A short note', body: 'Write the next sentence.', claimRefs: [claimId] },
        watchOuts: ['Do not turn the cue into a long planning session.'],
        action: 'Write one next task on paper.',
      },
    },
    visual: { title: 'The restart cue', altText: 'A visible next step.', textEquivalent: ['Name the next move.'], claimRefs: [claimId] },
    listen: {
      brief: { editorialBrief: { objective: 'Explain the cue.', tone: 'Clear.', keyPoints: ['Name the next move.'], claimRefs: [claimId] } },
      discussion: { editorialBrief: { objective: 'Discuss the cue.', tone: 'Practical.', keyPoints: ['Name the next move.'], claimRefs: [claimId] } },
    },
    quiz: { questions: [
      { id: 'q1', prompt: 'What helps you return?', options: [{ id: 'a', text: 'A cue' }, { id: 'b', text: 'Noise' }, { id: 'c', text: 'Guessing' }], correctOptionId: 'a', rationale: 'A cue names the next move.', reviewConcept: 'Restart cue', claimRefs: [claimId] },
      { id: 'q2', prompt: 'When do you write it?', options: [{ id: 'a', text: 'Before switching' }, { id: 'b', text: 'Never' }, { id: 'c', text: 'After forgetting' }], correctOptionId: 'a', rationale: 'Write it before switching.', reviewConcept: 'Timing', claimRefs: [claimId] },
      { id: 'q3', prompt: 'What should it be?', options: [{ id: 'a', text: 'Visible' }, { id: 'b', text: 'Hidden' }, { id: 'c', text: 'Vague' }], correctOptionId: 'a', rationale: 'Visibility makes return easier.', reviewConcept: 'Visibility', claimRefs: [claimId] },
    ] },
    claims: candidate.claims,
    claimCoverage: [
      { path: 'identity.title', claimIds: [claimId] },
      { path: 'learning.centralIdea', claimIds: [claimId] },
      { path: 'learning.whyItMatters', claimIds: [claimId] },
      { path: 'learning.oneLineToKeep', claimIds: [claimId] },
      { path: 'learning.action', claimIds: [claimId] },
      { path: 'read.story', claimIds: [claimId] },
      { path: 'read.playbook', claimIds: [claimId] },
      { path: 'visual', claimIds: [claimId] },
      { path: 'listen.brief', claimIds: [claimId] },
      { path: 'listen.discussion', claimIds: [claimId] },
      { path: 'quiz', claimIds: [claimId] },
    ],
    materialization: 'draft',
    contentModel: 'story-playbook.v1',
  } as const;

  const missing = runDeterministicChecks({
    candidate: {
      kind: 'nuglet.lesson.v1',
      schemaVersion: '1.1.0',
      payload: (() => {
        const payload = { ...basePayload } as Record<string, unknown>;
        delete payload.socialPost;
        return payload;
      })(),
    } as unknown as ContentCandidate,
    evidence: { sources: [{ ...evidence.sources[0], title: 'Focused work evidence' }] },
  });
  assert.ok(missing.findings.some(({ code }) => code === 'social-post'));

  const valid = runDeterministicChecks({
    candidate: { kind: 'nuglet.lesson.v1', schemaVersion: '1.1.0', payload: basePayload } as unknown as ContentCandidate,
    evidence: { sources: [{ ...evidence.sources[0], title: 'Focused work evidence' }] },
  });
  assert.equal(valid.findings.some(({ code }) => code === 'social-post'), false);
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

test('editorial parsing rejects empty and whitespace-only summaries', () => {
  for (const summary of ['', '   ']) {
    assert.throws(() => parseEditorialCheck({ findings: [], summary }), /summary/i);
  }
});
