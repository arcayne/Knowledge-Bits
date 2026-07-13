import assert from 'node:assert/strict';
import test from 'node:test';
import {
  knowledgeBitsContentSchema,
  knowledgeBitsEvidenceSchema,
  knowledgeBitsQaSchema,
  knowledgeBitsSchema,
  jobClaimSchema,
  jobResultSchema,
  reviewRunRequestSchema,
  stageStateSchema,
  workflowStageSchema,
} from '../dist/index.js';

const checksum = 'a'.repeat(64);
const packageId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const sourceId = '0f8fad5b-d9cb-469f-a165-70867728950f';
const claimId = '0f8fad5b-d9cb-469f-a165-708677289510';
const snapshotArtifactId = '0f8fad5b-d9cb-469f-a165-708677289512';

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
  const citation = {
    sourceId,
    snapshotArtifactId,
    excerpt: 'An emergency fund covers unexpected expenses.',
  };
  const claims = [{
    claimId,
    statement: 'A rainy day fund can help cover an unexpected expense.',
    citations: [citation],
  }];
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
        title: 'Build a rainy day fund',
        takeaway: 'A small reserve makes surprise costs easier to handle.',
        action: 'Choose a starter amount to set aside this week.',
        depths: {
          quick: 'Start with one small transfer.',
          core: 'A dedicated reserve separates surprise costs from normal spending.',
          deep: 'Build the reserve with repeatable transfers and review the target after major life changes.',
        },
        claims,
        claimCoverage: [
          { path: 'title', claimIds: [claimId] },
          { path: 'takeaway', claimIds: [claimId] },
          { path: 'action', claimIds: [claimId] },
          { path: 'depths.quick', claimIds: [claimId] },
          { path: 'depths.core', claimIds: [claimId] },
          { path: 'depths.deep', claimIds: [claimId] },
        ],
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
      acceptedSources: [{
        sourceId,
        url: 'https://example.com/source',
        title: 'Example source',
        retrievedAt: '2026-07-12T12:00:00.000Z',
        snapshot: { ...artifactReference('source_snapshot'), artifactId: snapshotArtifactId },
        readability: { passed: true, reason: null },
        credibility: { passed: true, policy: 'fixture-trusted-hosts.v1', reason: null },
      }],
      rejectedSources: [],
      coverageGaps: [],
      claims,
    },
    qa: {
      deterministic: { passed: true, contentChecksum: checksum, findings: [] },
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
    executionDeadlineAt: '2026-07-13T10:05:00.000Z',
    attempt: 1,
    revision: 1,
    input: { brief: { title: 'Build a rainy day fund' }, dependencies: [] },
  };
  assert.throws(() => jobClaimSchema.parse(claim), /immutable package identity/i);
  assert.equal(jobClaimSchema.parse({
    ...claim,
    deliveryId: '22222222-2222-4222-8222-222222222222',
    packageVersionId: '33333333-3333-4333-8333-333333333333',
    packageChecksum: checksum,
  }).packageVersionId, '33333333-3333-4333-8333-333333333333');
});

test('evidence citations resolve to accepted immutable source snapshots', () => {
  const evidence = validKnowledgeBits().evidence;
  assert.equal(knowledgeBitsEvidenceSchema.parse(evidence).acceptedSources[0].snapshot.artifactId, snapshotArtifactId);
  assert.throws(() => knowledgeBitsEvidenceSchema.parse({
    ...evidence,
    claims: [{
      ...evidence.claims[0],
      citations: [{ ...evidence.claims[0].citations[0], snapshotArtifactId: packageId }],
    }],
  }), /accepted snapshot/i);
  assert.throws(() => knowledgeBitsEvidenceSchema.parse({
    ...evidence,
    acceptedSources: [{
      ...evidence.acceptedSources[0],
      credibility: { passed: false, policy: 'fixture-trusted-hosts.v1', reason: 'host_not_trusted' },
    }],
  }), /accepted source/i);
});

test('the lesson payload requires complete claim coverage for every learner-facing field', () => {
  const content = { schemaVersion: 'knowledge-bits.content.v1', target: validKnowledgeBits().target };
  assert.equal(knowledgeBitsContentSchema.parse(content).target.payload.claimCoverage.length, 6);
  assert.throws(() => knowledgeBitsContentSchema.parse({
    ...content,
    target: {
      ...content.target,
      payload: { ...content.target.payload, claims: [], claimCoverage: [] },
    },
  }), /claim/i);
  assert.throws(() => knowledgeBitsContentSchema.parse({
    ...content,
    target: {
      ...content.target,
      payload: { ...content.target.payload, claimCoverage: content.target.payload.claimCoverage.slice(1) },
    },
  }), /coverage/i);
});

test('QA requires the engine-calculated content checksum and explicit blocking findings', () => {
  assert.equal(knowledgeBitsQaSchema.parse(validKnowledgeBits().qa).deterministic.contentChecksum, checksum);
  assert.throws(() => knowledgeBitsQaSchema.parse({
    deterministic: { passed: true, findings: [] },
    editorial: { summary: 'Ready.', findings: [] },
  }), /contentChecksum/i);
  assert.equal(knowledgeBitsQaSchema.parse({
    deterministic: { passed: true, contentChecksum: checksum, findings: [] },
    editorial: {
      summary: 'Blocked.',
      findings: [{ code: 'unsupported-claim', severity: 'major', blocking: true, message: 'Missing support.' }],
    },
  }).editorial.findings[0].blocking, true);
});

test('job outcomes distinguish configuration action from quality revision', () => {
  const base = {
    jobId: '11111111-1111-4111-8111-111111111111',
    packageId,
    stage: 'research',
    state: 'needs_human',
    completedAt: '2026-07-13T10:00:00.000Z',
    outputChecksum: null,
    error: 'provider_runtime_unconfigured:notebooklm',
  };
  assert.throws(() => jobResultSchema.parse(base), /needsHumanKind/i);
  assert.equal(jobResultSchema.parse({ ...base, needsHumanKind: 'configuration' }).needsHumanKind, 'configuration');
});
