import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { calculatePackageChecksum, nextTransition } from '@knowledge-bits/pipeline';

import { createApp } from '../app.js';
import type { ArtifactStorageAdapter } from '../services/artifacts.js';
import { ReviewPackageService } from '../services/review-packages.js';
import {
  createInMemoryWorkflowStore,
  type RecordPackageVersionInput,
  WorkflowRepository,
} from '../repositories/workflow-repository.js';

const checksumA = canonicalChecksum('A');
const checksumB = canonicalChecksum('B');
const sourceId = '11111111-1111-4111-8111-111111111111';

class ReviewStorage implements ArtifactStorageAdapter {
  readonly objects = new Map<string, Uint8Array>();

  async preparePut(): Promise<never> { throw new Error('not used'); }
  async inspect(): Promise<never> { throw new Error('not used'); }
  async read(storageKey: string): Promise<Uint8Array> {
    const object = this.objects.get(storageKey);
    if (!object) throw new Error('missing review fixture object');
    return object;
  }
}

function createTestApp() {
  const repository = new WorkflowRepository(createInMemoryWorkflowStore());
  const storage = new ReviewStorage();
  return {
    app: createApp({
      repository,
      artifactStorage: storage,
      env: {
        ENGINE_API_TOKEN: 'engine-api-test',
        ENGINE_REVIEW_TOKEN: 'engine-review-test',
        ENGINE_REVIEWER_ID: 'editor-1',
      },
    }),
    repository,
    storage,
  };
}

test('approval freezes the checksum and queues one delivery action', async () => {
  const { app, repository, storage } = createTestApp();
  const { runId, packageChecksum } = await reviewReadyRun(repository, storage, checksumA);

  const first = await app.request(`/runs/${runId}/review`, {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-review-test' },
    body: JSON.stringify({
      decision: 'approve',
      packageChecksum,
    }),
  });

  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.deepEqual(firstBody, {
    runId,
    currentStage: 'deliver',
    state: 'queued',
    currentRevision: 1,
    reviewStatus: 'approved',
    packageChecksum,
    approvedChecksum: packageChecksum,
  });

  const replay = await app.request(`/runs/${runId}/review`, {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-review-test' },
    body: JSON.stringify({
      decision: 'approve',
      packageChecksum,
    }),
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), firstBody);

  const delivery = await repository.claimJob({
    workerId: 'delivery-worker',
    capabilities: ['deliver_package'],
    leaseSeconds: 60,
  });
  assert.equal(delivery?.stage, 'deliver');
  assert.equal(await repository.claimJob({
    workerId: 'second-delivery-worker',
    capabilities: ['deliver_package'],
    leaseSeconds: 60,
  }), null);
});

test('changes require a comment, bind it to create, and content changes invalidate approval', async () => {
  const { app, repository, storage } = createTestApp();
  const { runId, packageChecksum } = await reviewReadyRun(repository, storage, checksumA);

  const missingComment = await app.request(`/runs/${runId}/review`, {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-review-test' },
    body: JSON.stringify({
      decision: 'request_changes',
      packageChecksum,
      comment: '   ',
    }),
  });
  assert.equal(missingComment.status, 400);

  const changes = await app.request(`/runs/${runId}/review`, {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-review-test' },
    body: JSON.stringify({
      decision: 'request_changes',
      packageChecksum,
      comment: 'Add the primary source to the learner copy.',
    }),
  });
  assert.equal(changes.status, 200);
  assert.equal((await changes.json()).currentRevision, 2);

  const replay = await app.request(`/runs/${runId}/review`, {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-review-test' },
    body: JSON.stringify({
      decision: 'request_changes',
      packageChecksum,
      comment: 'Add the primary source to the learner copy.',
    }),
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).currentRevision, 2);

  const conflictingComment = await app.request(`/runs/${runId}/review`, {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-review-test' },
    body: JSON.stringify({
      decision: 'request_changes',
      packageChecksum,
      comment: 'Replace the source instead.',
    }),
  });
  assert.equal(conflictingComment.status, 409);

  const create = await repository.claimJob({
    workerId: 'create-worker',
    capabilities: ['create_content'],
    leaseSeconds: 60,
  });
  assert.equal(create?.stage, 'create');
  const context = await repository.getJobContext(create!.jobId);
  assert.deepEqual(context?.job.input.review, {
    comment: 'Add the primary source to the learner copy.',
    packageChecksum,
  });

  const approvedReady = await reviewReadyRun(repository, storage, checksumA);
  const approved = await app.request(`/runs/${approvedReady.runId}/review`, {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-review-test' },
    body: JSON.stringify({ decision: 'approve', packageChecksum: approvedReady.packageChecksum }),
  });
  assert.equal(approved.status, 200);

  await repository.recordPackageVersion(packageVersionInput(approvedReady.runId, checksumB));
  const changed = await repository.getRun(approvedReady.runId);
  assert.ok(changed);
  assert.equal(changed.currentStage, 'human_review');
  assert.equal(changed.reviewStatus, 'pending');
  assert.equal(changed.approvedChecksum, null);
});

test('only the run-level review endpoint is available', async () => {
  const { app, repository, storage } = createTestApp();
  const { runId, packageChecksum } = await reviewReadyRun(repository, storage, checksumA);

  const artifactRoute = await app.request(`/runs/${runId}/artifacts/asset-1/review`, {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-review-test' },
    body: JSON.stringify({ decision: 'approve', packageChecksum, reviewerId: 'browser-controlled' }),
  });

  assert.equal(artifactRoute.status, 404);

  const untrustedIdentity = await app.request(`/runs/${runId}/review`, {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-review-test' },
    body: JSON.stringify({ decision: 'approve', packageChecksum, reviewerId: 'browser-controlled' }),
  });
  assert.equal(untrustedIdentity.status, 400);
});

async function reviewReadyRun(
  repository: WorkflowRepository,
  storage: ReviewStorage,
  checksum: string,
): Promise<{ runId: string; packageChecksum: string }> {
  const run = await repository.bootstrapRun({
    title: 'Build a rainy day fund',
    locale: 'en',
    brief: { objective: 'Build one practical learner lesson.' },
  });
  const capabilities = ['collect_sources', 'create_content', 'check_content', 'produce_assets'] as const;

  for (const capability of capabilities) {
    const claim = await repository.claimJob({ workerId: `${capability}-worker`, capabilities: [capability], leaseSeconds: 60 });
    assert.ok(claim);
    const context = await repository.getJobContext(claim.jobId);
    assert.ok(context);
    for (const artifact of stageArtifacts(capability)) {
      const id = randomUUID();
      const storageKey = `review-fixture/${run.id}/${capability}/${id}`;
      const body = typeof artifact.body === 'string'
        ? Buffer.from(artifact.body)
        : Buffer.from(JSON.stringify(artifact.body));
      storage.objects.set(storageKey, body);
      await repository.recordArtifactForActiveLease({
        workerId: `${capability}-worker`,
        jobId: claim.jobId,
        id,
        runId: run.id,
        revision: 1,
        kind: artifact.kind,
        mediaType: artifact.mediaType,
        checksum: 'a'.repeat(64),
        storageKey,
        byteSize: body.byteLength,
        provenance: { provider: 'review-fixture' },
        inputChecksum: null,
      });
    }
    await repository.applyJobResult({
      workerId: `${capability}-worker`,
      result: {
        jobId: claim.jobId,
        packageId: run.id,
        stage: claim.stage,
        state: 'done',
        completedAt: '2026-07-13T10:00:00.000Z',
        outputChecksum: checksum,
        error: null,
      },
      transition: nextTransition({
        stage: claim.stage,
        state: 'running',
        revisionAttempts: context.stage.revisionAttempts,
        packageChecksum: context.packageChecksum as `${string}` | null,
        approvedChecksum: context.approvedChecksum as `${string}` | null,
      }, { type: 'stage_completed', packageChecksum: checksum as `${string}` }),
    });
  }

  const model = await new ReviewPackageService({ repository, storage }).load(run.id);
  assert.ok(model.package);
  assert.equal(model.decisionAllowed, true);
  return { runId: run.id, packageChecksum: model.package.packageChecksum };
}

function stageArtifacts(capability: 'collect_sources' | 'create_content' | 'check_content' | 'produce_assets') {
  if (capability === 'collect_sources') return [{
    kind: 'parsed_output',
    mediaType: 'application/json',
    body: {
      sources: [{ sourceId, title: 'Emergency savings source', url: 'https://example.test/savings' }],
      claims: [{ statement: 'Small buffers can reduce disruption.', citations: [{ sourceId, excerpt: 'Buffers absorb shocks.' }] }],
    },
  }];
  if (capability === 'create_content') return [{
    kind: 'parsed_output',
    mediaType: 'application/json',
    body: { title: 'Build a rainy day fund', takeaway: 'Start small.', action: 'Set aside one amount.' },
  }];
  if (capability === 'check_content') return [{
    kind: 'parsed_output',
    mediaType: 'application/json',
    body: {
      deterministic: { passed: true, contentChecksum: 'c'.repeat(64), findings: [] },
      editorial: { summary: 'Ready', findings: [] },
    },
  }];
  return [
    { kind: 'hero', mediaType: 'image/webp', body: 'hero' },
    { kind: 'infographic', mediaType: 'image/webp', body: 'infographic' },
    { kind: 'audio', mediaType: 'audio/mpeg', body: 'audio' },
  ];
}

function packageVersionInput(id: string, packageChecksum: string): RecordPackageVersionInput {
  const material = canonicalMaterial(packageChecksum === checksumB ? 'B' : 'A');
  return {
    runId: id,
    revision: 1,
    packageChecksum,
    ...material,
  };
}

function canonicalChecksum(variant: string): string {
  const material = canonicalMaterial(variant);
  return calculatePackageChecksum({ ...material, assetInventory: material.artifactInventory });
}

function canonicalMaterial(variant: string) {
  return {
    adapterVersion: 'review-package@1',
    locale: 'en',
    owner: 'knowledge-bits-engine',
    usageRights: { scope: 'internal-review' },
    content: { schemaVersion: 'knowledge-bits.content.v1' as const, target: { kind: 'nuglet.lesson.v1' as const, payload: { title: `Build a rainy day fund ${variant}` } } },
    evidence: { schemaVersion: 'knowledge-bits.evidence.v1' as const, sources: [], claims: [] },
    qa: { deterministic: { passed: true, findings: [] }, editorial: { summary: 'Ready', findings: [] } },
    artifactInventory: [],
  };
}
