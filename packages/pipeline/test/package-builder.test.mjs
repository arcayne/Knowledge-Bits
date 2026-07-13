import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildKnowledgeBits,
  calculatePackageChecksum,
} from '../dist/index.js';

const checksum = 'a'.repeat(64);
const packageId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const sourceId = '0f8fad5b-d9cb-469f-a165-70867728950f';
const claimId = '0f8fad5b-d9cb-469f-a165-708677289510';
const snapshotArtifactId = '0f8fad5b-d9cb-469f-a165-708677289511';

function artifact(kind) {
  return {
    artifactId: snapshotArtifactId,
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

function input(overrides = {}) {
  const citation = {
    sourceId,
    snapshotArtifactId,
    excerpt: 'An emergency fund covers unexpected expenses.',
  };
  const claim = {
    claimId,
    statement: 'A rainy day fund can help cover an unexpected expense.',
    citations: [citation],
  };
  const payload = {
    title: 'Build a rainy day fund',
    takeaway: 'A small buffer can reduce financial disruption.',
    action: 'Set aside one affordable amount today.',
    depths: {
      quick: 'Choose one amount you can save today.',
      core: 'Keep the first transfer small enough to repeat.',
      deep: 'Review the buffer after an unexpected expense and adjust your contribution.',
    },
    claims: [claim],
    claimCoverage: [
      { path: 'title', claimIds: [claimId] },
      { path: 'takeaway', claimIds: [claimId] },
      { path: 'action', claimIds: [claimId] },
      { path: 'depths.quick', claimIds: [claimId] },
      { path: 'depths.core', claimIds: [claimId] },
      { path: 'depths.deep', claimIds: [claimId] },
    ],
  };
  const snapshot = artifact('source_snapshot');
  return {
    packageId,
    revision: 1,
    locale: 'en',
    owner: 'knowledge-team',
    riskClass: 'low',
    content: {
      schemaVersion: 'knowledge-bits.content.v1',
      target: {
        kind: 'nuglet.lesson.v1',
        payload,
      },
    },
    evidence: {
      schemaVersion: 'knowledge-bits.evidence.v1',
      acceptedSources: [{
        sourceId,
        url: 'https://example.com/source',
        title: 'Example source',
        retrievedAt: '2026-07-12T12:00:00.000Z',
        snapshot,
        readability: { passed: true, reason: null },
        credibility: { passed: true, policy: 'trusted-host', reason: null },
      }],
      rejectedSources: [],
      coverageGaps: [],
      claims: [claim],
    },
    qa: {
      deterministic: { passed: true, contentChecksum: checksum, findings: [] },
      editorial: { summary: 'Ready for review.', findings: [] },
    },
    surfaces: {
      manifest: artifact('manifest'),
      evidence: artifact('evidence'),
      content: artifact('content'),
      workflow: artifact('workflow'),
    },
    assetInventory: [artifact('image')],
    adapterVersion: 'nuglet-adapter@1.2.3',
    usageRights: { license: 'CC-BY-4.0', expiresAt: null },
    ...overrides,
  };
}

test('calculates a stable checksum independent of object key order', () => {
  const first = input();
  const second = input({
    usageRights: { expiresAt: null, license: 'CC-BY-4.0' },
  });

  assert.equal(calculatePackageChecksum(first), calculatePackageChecksum(second));
});

test('preserves array order in the checksum', () => {
  const first = input({ assetInventory: [artifact('image'), artifact('audio')] });
  const second = input({ assetInventory: [artifact('audio'), artifact('image')] });

  assert.notEqual(calculatePackageChecksum(first), calculatePackageChecksum(second));
});

test('changes when package content, evidence, QA, assets, adapter, locale, owner, or rights change', () => {
  const base = input();
  const baseChecksum = calculatePackageChecksum(base);
  const variations = [
    input({ content: { ...base.content, target: { ...base.content.target, payload: { title: 'A different lesson' } } } }),
    input({ evidence: { ...base.evidence, claims: [{ ...base.evidence.claims[0], statement: 'A different claim.' }] } }),
    input({ qa: { ...base.qa, editorial: { summary: 'Needs another pass.', findings: [] } } }),
    input({ assetInventory: [artifact('audio')] }),
    input({ adapterVersion: 'nuglet-adapter@1.2.4' }),
    input({ locale: 'es' }),
    input({ owner: 'another-team' }),
    input({ usageRights: { license: 'all-rights-reserved' } }),
  ];

  for (const variation of variations) {
    assert.notEqual(calculatePackageChecksum(variation), baseChecksum);
  }
});

test('rejects undefined checksum material', () => {
  assert.throws(
    () => calculatePackageChecksum(input({ usageRights: { license: undefined } })),
    /undefined/i,
  );
});

test('rejects sparse arrays in checksum material', () => {
  const sparseArray = [];
  sparseArray.length = 1;

  assert.throws(
    () => calculatePackageChecksum(input({ usageRights: sparseArray })),
    /sparse arrays/i,
  );
});

test('rejects Date instances in checksum material', () => {
  assert.throws(
    () => calculatePackageChecksum(input({ usageRights: new Date('2026-07-12T12:00:00.000Z') })),
    /plain objects/i,
  );
});

test('rejects Array subclasses in checksum material', () => {
  class UsageRights extends Array {}

  assert.throws(
    () => calculatePackageChecksum(input({ usageRights: new UsageRights('restricted') })),
    /plain arrays/i,
  );
});

test('builds a contract-valid unapproved package', () => {
  const result = buildKnowledgeBits(input());

  assert.equal(result.schemaVersion, 'knowledge-bits.package.v1');
  assert.equal(result.packageChecksum, calculatePackageChecksum(input()));
  assert.deepEqual(result.target, input().content.target);
  assert.deepEqual(result.approval, {
    status: 'unapproved',
    reviewerId: null,
    decidedAt: null,
    approvedChecksum: null,
    comment: null,
  });
});

test('excludes approval status from the package checksum', () => {
  const base = input();
  const unapproved = buildKnowledgeBits(base);
  const approved = buildKnowledgeBits({
    ...base,
    approval: {
      status: 'approved',
      reviewerId: 'operator-1',
      decidedAt: '2026-07-12T12:00:00.000Z',
      approvedChecksum: calculatePackageChecksum(base),
      comment: null,
    },
  });

  assert.equal(approved.packageChecksum, unapproved.packageChecksum);
  assert.equal(approved.approval.status, 'approved');
});
