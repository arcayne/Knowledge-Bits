import assert from 'node:assert/strict';
import test from 'node:test';
import {
  knowledgeBitsSchema,
  jobClaimSchema,
  reviewRunRequestSchema,
  stageStateSchema,
  workflowStageSchema,
} from '../dist/index.js';

const checksum = 'a'.repeat(64);
const packageId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const sourceId = '0f8fad5b-d9cb-469f-a165-70867728950f';
const claimId = '0f8fad5b-d9cb-469f-a165-708677289510';

function artifactReference(kind) {
  return {
    artifactId: '0f8fad5b-d9cb-469f-a165-708677289511',
    kind,
    mediaType: 'application/json',
    checksum,
    storageKey: `packages/${kind}.json`,
    byteSize: 128,
    createdAt: '2026-07-12T12:00:00.000Z',
    provider: 'fixture',
    inputChecksum: null,
  };
}

function validKnowledgeBits() {
  return {
    schemaVersion: 'knowledge-bits.package.v1',
    packageId,
    revision: 1,
    locale: 'en',
    owner: 'knowledge-team',
    riskClass: 'low',
    target: {
      kind: 'nuglet.lesson.v1',
      payload: {
        lessonId: packageId,
        slug: 'build-a-rainy-day-fund',
        title: 'Build a rainy day fund',
      },
    },
    surfaces: {
      manifest: artifactReference('manifest'),
      evidence: artifactReference('evidence'),
      content: artifactReference('content'),
      workflow: artifactReference('workflow'),
    },
    evidence: {
      schemaVersion: 'knowledge-bits.evidence.v1',
      sources: [{
        sourceId,
        url: 'https://example.com/source',
        title: 'Example source',
        retrievedAt: '2026-07-12T12:00:00.000Z',
        checksum,
      }],
      claims: [{
        claimId,
        statement: 'A rainy day fund can help cover an unexpected expense.',
        citations: [{ sourceId, excerpt: 'An emergency fund covers unexpected expenses.' }],
      }],
    },
    qa: {
      deterministic: { passed: true, findings: [] },
      editorial: { summary: 'Ready for review.', findings: [] },
    },
    packageChecksum: checksum,
    approval: {
      status: 'unapproved',
      reviewerId: null,
      decidedAt: null,
      approvedChecksum: null,
      comment: null,
    },
  };
}

test('uses the six approved stages and five visible states', () => {
  assert.deepEqual(workflowStageSchema.options, [
    'research', 'create', 'check', 'produce_assets', 'human_review', 'deliver',
  ]);
  assert.deepEqual(stageStateSchema.options, [
    'queued', 'running', 'waiting', 'needs_human', 'done',
  ]);
});

test('approval must bind the exact package checksum', () => {
  const input = validKnowledgeBits();
  input.approval = {
    status: 'approved',
    reviewerId: 'operator-1',
    decidedAt: '2026-07-12T12:00:00.000Z',
    approvedChecksum: 'different-checksum',
    comment: null,
  };
  assert.throws(() => knowledgeBitsSchema.parse(input), /approved checksum/i);
});

test('changes requested require a human comment', () => {
  const input = validKnowledgeBits();
  input.approval = {
    status: 'changes_requested',
    reviewerId: 'operator-1',
    decidedAt: '2026-07-12T12:00:00.000Z',
    approvedChecksum: null,
    comment: '',
  };
  assert.throws(() => knowledgeBitsSchema.parse(input), /comment/i);
});

test('accepts a complete unapproved package with all four surfaces', () => {
  assert.deepEqual(knowledgeBitsSchema.parse(validKnowledgeBits()).packageId, packageId);
});

test('review requests never accept a caller supplied reviewer identity', () => {
  assert.deepEqual(reviewRunRequestSchema.parse({
    decision: 'approve',
    packageChecksum: checksum,
  }), {
    decision: 'approve',
    packageChecksum: checksum,
  });
  assert.throws(() => reviewRunRequestSchema.parse({
    decision: 'approve',
    packageChecksum: checksum,
    reviewerId: 'browser-controlled',
  }));
});

test('delivery claims carry the immutable package handoff', () => {
  const claim = {
    jobId: '11111111-1111-4111-8111-111111111111',
    packageId,
    stage: 'deliver',
    claimedBy: 'delivery-worker',
    claimedAt: '2026-07-13T10:00:00.000Z',
    leaseExpiresAt: '2026-07-13T10:01:00.000Z',
    attempt: 1,
    revision: 1,
  };
  assert.throws(() => jobClaimSchema.parse(claim), /immutable package identity/i);
  assert.equal(jobClaimSchema.parse({
    ...claim,
    deliveryId: '22222222-2222-4222-8222-222222222222',
    packageVersionId: '33333333-3333-4333-8333-333333333333',
    packageChecksum: checksum,
  }).packageVersionId, '33333333-3333-4333-8333-333333333333');
});
