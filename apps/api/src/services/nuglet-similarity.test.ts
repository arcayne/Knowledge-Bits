import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkflowRun } from '../repositories/workflow-repository.js';
import { analyzeNugletSimilarity } from './nuglet-similarity.js';

test('marks the same normalized title as a likely duplicate', () => {
  const result = analyzeNugletSimilarity({
    title: 'Protect your attention!',
    objective: 'Notice attention traps and recover focus.',
    locale: 'en',
  }, [
    run('0f8fad5b-d9cb-469f-a165-70867728950e', 'Protect Your Attention', 'Build a kinder focus habit.'),
  ]);

  assert.equal(result.risk, 'likely_duplicate');
  assert.equal(result.matches[0]?.score, 1);
  assert.deepEqual(result.matches[0]?.reasons, ['same normalized title', 'shared title terms: attention, protect', 'shared concepts: attention']);
});

test('finds conceptually related decision lessons with different wording', () => {
  const result = analyzeNugletSimilarity({
    title: "Why You're Predictably Irrational",
    objective: 'Recognize how framing, free offers, ownership, and expectations distort decisions.',
    locale: 'en',
  }, [
    run(
      '0f8fad5b-d9cb-469f-a165-70867728950f',
      'Why do smart people make bad decisions?',
      'Understand why intelligence does not prevent predictable decision errors.',
    ),
    run(
      '0f8fad5b-d9cb-469f-a165-708677289510',
      'How to remember what you learn',
      'Use retrieval practice to improve memory.',
    ),
  ]);

  assert.equal(result.risk, 'related');
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0]?.title, 'Why do smart people make bad decisions?');
  assert.match(result.matches[0]?.reasons.join(' ') ?? '', /decision_bias/);
});

test('returns no matches for unrelated intake and keeps fingerprints deterministic', () => {
  const input = {
    title: 'How volcanoes reshape islands',
    objective: 'Explain how lava creates new land over time.',
    locale: 'en',
  };
  const runs = [
    run(
      '0f8fad5b-d9cb-469f-a165-70867728950e',
      'Protect Your Attention',
      'Build a kinder focus habit.',
    ),
  ];

  const first = analyzeNugletSimilarity(input, runs);
  const second = analyzeNugletSimilarity(input, [...runs].reverse());
  assert.equal(first.risk, 'none');
  assert.deepEqual(first.matches, []);
  assert.equal(first.fingerprint, second.fingerprint);
});

function run(id: string, title: string, objective: string): WorkflowRun {
  const now = new Date('2026-07-27T12:00:00.000Z');
  return {
    id,
    title,
    locale: 'en',
    brief: { title, objective },
    currentStage: 'human_review',
    currentRevision: 1,
    packageChecksum: null,
    approvedChecksum: null,
    reviewStatus: 'pending',
    stages: {},
    nextRetryAt: null,
    createdAt: now,
    updatedAt: now,
  };
}
