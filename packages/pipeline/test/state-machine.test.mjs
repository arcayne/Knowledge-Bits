import assert from 'node:assert/strict';
import test from 'node:test';

import { STAGES, nextTransition, WorkflowTransitionError } from '../dist/index.js';

const CHECKSUM = 'a'.repeat(64);
const CHANGED_CHECKSUM = 'b'.repeat(64);

function snapshot(overrides = {}) {
  return {
    stage: 'research',
    state: 'queued',
    revisionAttempts: 0,
    packageChecksum: CHECKSUM,
    approvedChecksum: null,
    ...overrides,
  };
}

function reviewSnapshot(overrides = {}) {
  return snapshot({
    stage: 'human_review',
    state: 'needs_human',
    ...overrides,
  });
}

test('keeps the approved stages in pipeline order', () => {
  assert.deepEqual(STAGES, [
    'research', 'create', 'check', 'produce_assets', 'human_review', 'deliver',
  ]);
});

test('starts queued work without changing its stage', () => {
  const result = nextTransition(snapshot(), { type: 'job_started' });

  assert.equal(result.stage, 'research');
  assert.equal(result.state, 'running');
  assert.deepEqual(result.effects, []);
});

test('restarts waiting work without changing its stage', () => {
  const result = nextTransition(snapshot({ state: 'waiting' }), { type: 'job_started' });

  assert.equal(result.stage, 'research');
  assert.equal(result.state, 'running');
  assert.deepEqual(result.effects, []);
});

test('rejects malformed human review snapshots before starting work', () => {
  assert.throws(
    () => nextTransition(snapshot({ stage: 'human_review', state: 'queued' }), { type: 'job_started' }),
    /invalid workflow snapshot.*human_review\/queued/i,
  );
});

test('validates stage and state combinations for package changes', () => {
  assert.throws(
    () => nextTransition(snapshot({ state: 'needs_human' }), {
      type: 'package_changed', packageChecksum: CHANGED_CHECKSUM,
    }),
    /invalid workflow snapshot.*research\/needs_human/i,
  );
});

test('marks running work as waiting', () => {
  const result = nextTransition(snapshot({ state: 'running' }), {
    type: 'job_waiting', reason: 'source rate limit',
  });

  assert.equal(result.state, 'waiting');
  assert.equal(result.reason, 'source rate limit');
});

test('advances each automated stage in order and queues the next job', () => {
  const cases = [
    ['research', 'create'],
    ['create', 'check'],
    ['check', 'produce_assets'],
  ];

  for (const [stage, nextStage] of cases) {
    const result = nextTransition(snapshot({ stage, state: 'running' }), {
      type: 'stage_completed', packageChecksum: CHECKSUM,
    });

    assert.equal(result.stage, nextStage);
    assert.equal(result.state, 'queued');
    assert.deepEqual(result.effects, [{ type: 'queue_stage', stage: nextStage }]);
  }
});

test('moves completed asset production to human review', () => {
  const result = nextTransition(snapshot({ stage: 'produce_assets', state: 'running' }), {
    type: 'stage_completed', packageChecksum: CHECKSUM,
  });

  assert.equal(result.stage, 'human_review');
  assert.equal(result.state, 'needs_human');
  assert.deepEqual(result.effects, [{ type: 'request_review', packageChecksum: CHECKSUM }]);
});

test('a failed quality check queues a revision before the human threshold', () => {
  const result = nextTransition(snapshot({ stage: 'check', state: 'running' }), {
    type: 'quality_failed', reason: 'unsupported_claim',
  });

  assert.equal(result.stage, 'create');
  assert.equal(result.state, 'queued');
  assert.equal(result.revisionAttempts, 1);
  assert.deepEqual(result.effects, [{ type: 'queue_stage', stage: 'create' }]);
});

test('two failed revisions require a human', () => {
  const result = nextTransition(snapshot({
    stage: 'check', state: 'running', revisionAttempts: 2,
  }), {
    type: 'quality_failed', reason: 'unsupported_claim',
  });

  assert.equal(result.stage, 'check');
  assert.equal(result.state, 'needs_human');
  assert.equal(result.effects[0].type, 'request_human');
});

test('approval moves human review to delivery without a second approval', () => {
  const result = nextTransition(reviewSnapshot(), {
    type: 'review_approved',
    packageChecksum: CHECKSUM,
    reviewerId: 'operator-1',
  });

  assert.equal(result.stage, 'deliver');
  assert.equal(result.state, 'queued');
  assert.equal(result.effects[0].type, 'queue_delivery');
  assert.equal(result.approvedChecksum, CHECKSUM);
});

test('changes requested queue a new create stage', () => {
  const result = nextTransition(reviewSnapshot(), {
    type: 'changes_requested', reason: 'clarify the evidence', reviewerId: 'operator-1',
  });

  assert.equal(result.stage, 'create');
  assert.equal(result.state, 'queued');
  assert.deepEqual(result.effects, [{ type: 'queue_stage', stage: 'create' }]);
});

test('a changed package after approval returns to human review', () => {
  const result = nextTransition(snapshot({
    stage: 'deliver',
    state: 'queued',
    approvedChecksum: CHECKSUM,
  }), {
    type: 'package_changed', packageChecksum: CHANGED_CHECKSUM,
  });

  assert.equal(result.stage, 'human_review');
  assert.equal(result.state, 'needs_human');
  assert.equal(result.approvedChecksum, null);
  assert.deepEqual(result.effects, [{ type: 'request_review', packageChecksum: CHANGED_CHECKSUM }]);
});

test('records successful delivery', () => {
  const result = nextTransition(snapshot({ stage: 'deliver', state: 'running' }), {
    type: 'delivery_succeeded',
  });

  assert.equal(result.stage, 'deliver');
  assert.equal(result.state, 'done');
  assert.deepEqual(result.effects, [{ type: 'record_delivery', state: 'succeeded' }]);
});

test('queues a failed delivery for retry', () => {
  const result = nextTransition(snapshot({ stage: 'deliver', state: 'running' }), {
    type: 'delivery_failed', reason: 'target unavailable',
  });

  assert.equal(result.stage, 'deliver');
  assert.equal(result.state, 'queued');
  assert.deepEqual(result.effects, [{ type: 'queue_delivery', packageChecksum: CHECKSUM }]);
});

test('sends a permanent delivery schema failure to human review', () => {
  const result = nextTransition(snapshot({ stage: 'deliver', state: 'running' }), {
    type: 'delivery_needs_human', reason: 'destination schema rejected',
  });

  assert.equal(result.stage, 'deliver');
  assert.equal(result.state, 'needs_human');
  assert.equal(result.reason, 'destination schema rejected');
  assert.deepEqual(result.effects, []);
});

test('rejects events that select a stage or violate the transition table', () => {
  assert.throws(
    () => nextTransition(snapshot(), { type: 'job_started', stage: 'deliver' }),
    WorkflowTransitionError,
  );
  assert.throws(
    () => nextTransition(snapshot(), { type: 'review_approved', packageChecksum: CHECKSUM, reviewerId: 'operator-1' }),
    WorkflowTransitionError,
  );
});
