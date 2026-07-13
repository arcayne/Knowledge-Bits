import type { NugletLessonV1Payload } from '@knowledge-bits/contracts';
import { calculateContentChecksum, calculatePackageChecksum } from '@knowledge-bits/pipeline';

import type { RecordPackageVersionInput } from '../repositories/workflow-repository.js';

const sourceId = '10000000-0000-4000-8000-000000000001';
const snapshotArtifactId = '10000000-0000-4000-8000-000000000002';
const claimId = '10000000-0000-4000-8000-000000000003';
const snapshotChecksum = '1'.repeat(64);

export function strictPackageVersionInput(
  runId: string,
  variant: string,
  revision = 1,
): RecordPackageVersionInput {
  const citation = {
    sourceId,
    snapshotArtifactId,
    excerpt: 'A small, specific action is easier to complete.',
  };
  const claim = {
    claimId,
    statement: `Complete one useful action for ${variant}.`,
    citations: [citation],
  };
  const payload: NugletLessonV1Payload = {
    title: `One useful action ${variant}`,
    takeaway: 'A small action can create useful momentum.',
    action: 'Choose and complete one useful action today.',
    depths: {
      quick: 'Pick one action that takes less than ten minutes.',
      core: 'Make the action specific, bounded, and observable.',
      deep: 'Repeat the action after reviewing what made completion easier.',
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
  const snapshot = {
    artifactId: snapshotArtifactId,
    kind: 'source_snapshot',
    mediaType: 'text/html',
    checksum: snapshotChecksum,
    storageKey: 'testing/source-snapshot.html',
    byteSize: 128,
    createdAt: '2026-07-13T09:00:00.000Z',
    provider: 'source-verifier',
    inputChecksum: null,
  };
  const material = {
    adapterVersion: 'knowledge-bits.review-package.v1',
    locale: 'en',
    owner: 'knowledge-bits-engine',
    usageRights: { scope: 'internal-review' },
    content: {
      schemaVersion: 'knowledge-bits.content.v1' as const,
      target: { kind: 'nuglet.lesson.v1' as const, payload },
    },
    evidence: {
      schemaVersion: 'knowledge-bits.evidence.v1' as const,
      acceptedSources: [{
        sourceId,
        url: 'https://example.test/source',
        title: 'Action research',
        retrievedAt: '2026-07-13T09:00:00.000Z',
        snapshot,
        readability: { passed: true, reason: null },
        credibility: { passed: true, policy: 'trusted-host', reason: null },
      }],
      rejectedSources: [],
      coverageGaps: [],
      claims: [claim],
    },
    qa: {
      deterministic: {
        passed: true,
        contentChecksum: calculateContentChecksum(payload),
        findings: [],
      },
      editorial: { summary: 'Ready', findings: [] },
    },
    artifactInventory: [snapshot],
  };

  return {
    runId,
    revision,
    packageChecksum: calculatePackageChecksum({
      ...material,
      assetInventory: material.artifactInventory,
    }),
    ...material,
  };
}
