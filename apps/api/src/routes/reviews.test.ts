import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { calculateContentChecksum, nextTransition } from '@knowledge-bits/pipeline';
import type { JobClaim, NugletLessonV1Payload } from '@knowledge-bits/contracts';

import { createApp } from '../app.js';
import type { ArtifactStorageAdapter } from '../services/artifacts.js';
import { ReviewPackageService } from '../services/review-packages.js';
import {
  createInMemoryWorkflowStore,
  WorkflowRepository,
} from '../repositories/workflow-repository.js';
import { strictLegacyReplacementBrief, strictPackageVersionInput } from '../testing/knowledge-bits-fixture.js';

const checksumA = 'a'.repeat(64);
const sourceId = '11111111-1111-4111-8111-111111111111';
const reviewHeaders = {
  Authorization: 'Bearer engine-review-test',
  'X-Knowledge-Bits-Reviewer': 'editor-1',
};

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
    headers: reviewHeaders,
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
    headers: reviewHeaders,
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

test('infographic regeneration supersedes queued delivery and requires approval again', async () => {
  const { app, repository, storage } = createTestApp();
  const regenerationBrief = strictLegacyReplacementBrief();
  const generationPlan = regenerationBrief.generationPlan as Record<string, unknown>;
  delete generationPlan.mediaBaseline;
  generationPlan.mediaMode = 'generate';
  const { runId, packageChecksum } = await reviewReadyRun(repository, storage, checksumA, regenerationBrief);

  const approved = await app.request(`/runs/${runId}/review`, {
    method: 'POST',
    headers: reviewHeaders,
    body: JSON.stringify({ decision: 'approve', packageChecksum }),
  });
  assert.equal(approved.status, 200, await approved.clone().text());

  const regenerated = await app.request(`/runs/${runId}/regenerate-media`, {
    method: 'POST',
    headers: { ...reviewHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kinds: ['infographic'],
      recipeOverrides: {
        infographic: {
          id: 'nuglet.visual.infographic',
          version: '1.1.0',
          checksum: `sha256:${'b'.repeat(64)}`,
        },
      },
    }),
  });

  assert.equal(regenerated.status, 202, await regenerated.clone().text());
  assert.deepEqual(await regenerated.json(), {
    runId,
    currentStage: 'produce_assets',
    state: 'queued',
    currentRevision: 1,
    reviewStatus: 'pending',
    packageChecksum: null,
  });
  const media = await repository.claimJob({
    workerId: 'asset-worker',
    capabilities: ['produce_assets', 'deliver_package'],
    leaseSeconds: 60,
  });
  assert.equal(media?.stage, 'produce_assets');
  assert.deepEqual(media?.input.mediaKinds, ['infographic']);
  assert.deepEqual(
    ((media?.input.brief as Record<string, unknown>).generationPlan as Record<string, any>).recipes.infographic,
    {
      id: 'nuglet.visual.infographic',
      version: '1.1.0',
      checksum: `sha256:${'b'.repeat(64)}`,
    },
  );
  const updatedRun = await repository.getRun(runId);
  assert.equal(
    (((updatedRun?.brief.generationPlan as Record<string, any>).recipes as Record<string, any>).infographic).version,
    '1.1.0',
  );
  assert.deepEqual(updatedRun?.brief.mediaRegeneration, {
    sourcePackageChecksum: packageChecksum,
    regeneratedKinds: ['infographic'],
  });
});

test('public preview regeneration queues exactly one Short and requires approval again', async () => {
  const { app, repository, storage } = createTestApp();
  const regenerationBrief = strictLegacyReplacementBrief();
  const generationPlan = regenerationBrief.generationPlan as Record<string, unknown>;
  delete generationPlan.mediaBaseline;
  generationPlan.mediaMode = 'generate';
  const { runId, packageChecksum } = await reviewReadyRun(repository, storage, checksumA, regenerationBrief);

  const approved = await app.request(`/runs/${runId}/review`, {
    method: 'POST',
    headers: reviewHeaders,
    body: JSON.stringify({ decision: 'approve', packageChecksum }),
  });
  assert.equal(approved.status, 200, await approved.clone().text());

  const regenerated = await app.request(`/runs/${runId}/regenerate-media`, {
    method: 'POST',
    headers: { ...reviewHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kinds: ['public_preview'] }),
  });

  assert.equal(regenerated.status, 202, await regenerated.clone().text());
  const media = await repository.claimJob({
    workerId: 'short-worker',
    capabilities: ['produce_assets'],
    leaseSeconds: 60,
  });
  assert.deepEqual(media?.input.mediaKinds, ['public_preview']);
  const updatedRun = await repository.getRun(runId);
  assert.equal(updatedRun?.reviewStatus, 'pending');
  assert.deepEqual(updatedRun?.brief.mediaRegeneration, {
    sourcePackageChecksum: packageChecksum,
    regeneratedKinds: ['public_preview'],
  });
});

test('replays an earlier immutable approval after a newer package is pending review', async () => {
  const { app, repository, storage } = createTestApp();
  const packageA = await reviewReadyRun(repository, storage, checksumA);

  const approved = await app.request(`/runs/${packageA.runId}/review`, {
    method: 'POST',
    headers: reviewHeaders,
    body: JSON.stringify({ decision: 'approve', packageChecksum: packageA.packageChecksum }),
  });
  assert.equal(approved.status, 200, await approved.clone().text());

  const packageB = strictPackageVersionInput(packageA.runId, 'B');
  await repository.recordPackageVersion(packageB);
  const beforeReplay = await repository.getRun(packageA.runId);
  assert.ok(beforeReplay);
  assert.equal(beforeReplay.currentStage, 'human_review');
  assert.equal(beforeReplay.reviewStatus, 'pending');
  assert.equal(beforeReplay.packageChecksum, packageB.packageChecksum);
  assert.equal(beforeReplay.approvedChecksum, null);

  repository.listArtifactsForSuccessfulStageJobs = async () => [];

  const replay = await app.request(`/runs/${packageA.runId}/review`, {
    method: 'POST',
    headers: reviewHeaders,
    body: JSON.stringify({ decision: 'approve', packageChecksum: packageA.packageChecksum }),
  });

  assert.equal(replay.status, 200, await replay.clone().text());
  assert.deepEqual(await replay.json(), {
    runId: packageA.runId,
    currentStage: 'human_review',
    state: 'needs_human',
    currentRevision: 1,
    reviewStatus: 'pending',
    packageChecksum: packageB.packageChecksum,
    approvedChecksum: null,
  });
  assert.deepEqual(await repository.getRun(packageA.runId), beforeReplay);
  assert.equal(await repository.claimJob({
    workerId: 'delivery-worker',
    capabilities: ['deliver_package'],
    leaseSeconds: 60,
  }), null);
});

test('changes require a comment, bind it to create, and content changes invalidate approval', async () => {
  const { app, repository, storage } = createTestApp();
  const { runId, packageChecksum } = await reviewReadyRun(repository, storage, checksumA);

  const missingComment = await app.request(`/runs/${runId}/review`, {
    method: 'POST',
    headers: reviewHeaders,
    body: JSON.stringify({
      decision: 'request_changes',
      packageChecksum,
      comment: '   ',
    }),
  });
  assert.equal(missingComment.status, 400);

  const changes = await app.request(`/runs/${runId}/review`, {
    method: 'POST',
    headers: reviewHeaders,
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
    headers: reviewHeaders,
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
    headers: reviewHeaders,
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
  assert.ok(Array.isArray(create?.input.dependencies));
  assert.ok(create.input.dependencies.some((dependency) => (
    typeof dependency === 'object'
      && dependency !== null
      && 'action' in dependency
      && dependency.action === 'collect_sources'
  )));

  const priorPackage = await repository.getPackageVersion(runId, packageChecksum);
  assert.ok(priorPackage);
  await finishRevisionFromCreate(repository, storage, create, priorPackage);
  const revisedModel = await new ReviewPackageService({ repository, storage }).load(runId);
  assert.ok(revisedModel.package);
  assert.equal(revisedModel.package.revision, 2);
  assert.equal(revisedModel.package.evidence.acceptedSources.length, 1);
  assert.equal(revisedModel.decisionAllowed, true);
  const reapproved = await app.request(`/runs/${runId}/review`, {
    method: 'POST',
    headers: reviewHeaders,
    body: JSON.stringify({ decision: 'approve', packageChecksum: revisedModel.package.packageChecksum }),
  });
  assert.equal(reapproved.status, 200, await reapproved.clone().text());
  assert.equal((await reapproved.json()).reviewStatus, 'approved');

  const approvedReady = await reviewReadyRun(repository, storage, checksumA);
  const approved = await app.request(`/runs/${approvedReady.runId}/review`, {
    method: 'POST',
    headers: reviewHeaders,
    body: JSON.stringify({ decision: 'approve', packageChecksum: approvedReady.packageChecksum }),
  });
  assert.equal(approved.status, 200);

  await repository.recordPackageVersion(strictPackageVersionInput(approvedReady.runId, 'B'));
  const changed = await repository.getRun(approvedReady.runId);
  assert.ok(changed);
  assert.equal(changed.currentStage, 'human_review');
  assert.equal(changed.reviewStatus, 'pending');
  assert.equal(changed.approvedChecksum, null);
});

test('does not select successful media from a prior revision', async () => {
  const { app, repository, storage } = createTestApp();
  const { runId, packageChecksum } = await reviewReadyRun(repository, storage, checksumA);
  const changes = await app.request(`/runs/${runId}/review`, {
    method: 'POST',
    headers: reviewHeaders,
    body: JSON.stringify({
      decision: 'request_changes',
      packageChecksum,
      comment: 'Change only the approved media direction.',
    }),
  });
  assert.equal(changes.status, 200, await changes.clone().text());
  assert.equal((await changes.json()).currentRevision, 2);

  const repositoryArtifacts = await repository.listArtifactsForSuccessfulStageJobs(runId, 2);
  assert.ok(repositoryArtifacts.some((artifact) => artifact.kind === 'hero' && artifact.revision === 1));

  const model = await new ReviewPackageService({ repository, storage }).load(runId);
  assert.equal(model.currentRevision, 2);
  assert.equal(model.assets.hero.state, 'missing');
  assert.equal(model.assets.infographic.state, 'missing');
  assert.equal(model.assets.audioBrief.state, 'missing');
  assert.equal(model.assets.audioDiscussion.state, 'missing');
  assert.ok(!model.package?.artifactInventory.some((artifact) => (
    ['hero', 'infographic', 'audio_brief', 'audio_discussion'].includes(artifact.kind)
  )));
});

test('automatic quality revision carries accepted evidence through package assembly and approval', async () => {
  const { app, repository, storage } = createTestApp();
  const run = await repository.bootstrapRun({
    title: 'Automatic evidence carry-forward',
    locale: 'en',
    brief: { objective: 'Keep accepted sources while revising content.' },
  });
  const fixtures = reviewStageFixtures();
  const research = await requiredClaim(repository, 'collect_sources', 'research-worker');
  await recordClaimArtifacts(repository, storage, research, 'research-worker', fixtures.collect_sources);
  await completeClaim(repository, research, 'research-worker');

  const firstCreate = await requiredClaim(repository, 'create_content', 'create-worker');
  await recordClaimArtifacts(repository, storage, firstCreate, 'create-worker', fixtures.create_content);
  await completeClaim(repository, firstCreate, 'create-worker');
  const firstCheck = await requiredClaim(repository, 'check_content', 'check-worker');
  const firstCheckContext = await repository.getJobContext(firstCheck.jobId);
  assert.ok(firstCheckContext);
  await repository.applyJobResult({
    workerId: 'check-worker',
    result: {
      jobId: firstCheck.jobId,
      packageId: run.id,
      stage: 'check',
      state: 'needs_human',
      completedAt: '2026-07-13T10:05:00.000Z',
      outputChecksum: null,
      error: 'deterministic_quality_failed',
      needsHumanKind: 'quality',
    },
    transition: nextTransition({
      stage: firstCheckContext.stage.name,
      state: firstCheckContext.stage.state,
      revisionAttempts: firstCheckContext.stage.revisionAttempts,
      packageChecksum: firstCheckContext.packageChecksum as `${string}` | null,
      approvedChecksum: firstCheckContext.approvedChecksum as `${string}` | null,
    }, { type: 'quality_failed', reason: 'deterministic_quality_failed' }),
  });

  const secondCreate = await requiredClaim(repository, 'create_content', 'create-worker');
  assert.equal(secondCreate.revision, 2);
  assert.ok(Array.isArray(secondCreate.input.dependencies));
  assert.ok(secondCreate.input.dependencies.some((dependency) => (
    typeof dependency === 'object'
      && dependency !== null
      && 'action' in dependency
      && dependency.action === 'collect_sources'
  )));
  await recordClaimArtifacts(repository, storage, secondCreate, 'create-worker', fixtures.create_content);
  await completeClaim(repository, secondCreate, 'create-worker');
  const secondCheck = await requiredClaim(repository, 'check_content', 'check-worker');
  await recordClaimArtifacts(repository, storage, secondCheck, 'check-worker', fixtures.check_content);
  await completeClaim(repository, secondCheck, 'check-worker');
  const assets = await requiredClaim(repository, 'produce_assets', 'asset-worker');
  await recordClaimArtifacts(repository, storage, assets, 'asset-worker', fixtures.produce_assets);
  await completeClaim(repository, assets, 'asset-worker');

  const model = await new ReviewPackageService({ repository, storage }).load(run.id);
  assert.ok(model.package);
  assert.equal(model.package.revision, 2);
  assert.equal(model.package.evidence.acceptedSources.length, 1);
  assert.equal(model.package.evidence.acceptedSources[0]?.snapshot.artifactId, fixtures.collect_sources[0]?.id);
  assert.equal(model.decisionAllowed, true);
  const approved = await app.request(`/runs/${run.id}/review`, {
    method: 'POST',
    headers: reviewHeaders,
    body: JSON.stringify({ decision: 'approve', packageChecksum: model.package.packageChecksum }),
  });
  assert.equal(approved.status, 200, await approved.clone().text());
  assert.equal((await approved.json()).reviewStatus, 'approved');
});

test('a legacy editorial check with blocking findings queues asset production but blocks review approval', async () => {
  const { repository, storage } = createTestApp();
  const run = await repository.bootstrapRun({
    title: 'Editorial warning review',
    locale: 'en',
    brief: { objective: 'Keep editorial evidence for the human decision.' },
  });
  const fixtures = reviewStageFixtures();
  const contentChecksum = (fixtures.check_content[0]!.body as {
    deterministic: { contentChecksum: string };
  }).deterministic.contentChecksum;

  const research = await requiredClaim(repository, 'collect_sources', 'research-worker');
  await recordClaimArtifacts(repository, storage, research, 'research-worker', fixtures.collect_sources);
  await completeClaim(repository, research, 'research-worker');

  const create = await requiredClaim(repository, 'create_content', 'create-worker');
  await recordClaimArtifacts(repository, storage, create, 'create-worker', fixtures.create_content);
  await completeClaim(repository, create, 'create-worker');

  const check = await requiredClaim(repository, 'check_content', 'check-worker');
  await recordClaimArtifacts(repository, storage, check, 'check-worker', [{
    kind: 'parsed_output',
    mediaType: 'application/json',
    body: {
      deterministic: { passed: true, contentChecksum, findings: [] },
      editorial: {
        summary: 'Review the cited claim before publishing.',
        findings: [{
          code: 'unsupported-claim',
          severity: 'major',
          blocking: true,
          message: 'A claim needs a stronger source.',
        }],
      },
    },
  }]);
  await completeClaim(repository, check, 'check-worker');

  const assets = await requiredClaim(repository, 'produce_assets', 'asset-worker');
  assert.equal(assets.revision, 1);
  await recordClaimArtifacts(repository, storage, assets, 'asset-worker', fixtures.produce_assets);
  await completeClaim(repository, assets, 'asset-worker');

  const model = await new ReviewPackageService({ repository, storage }).load(run.id);
  assert.equal(model.decisionAllowed, false);
  assert.match(model.issues.join(' '), /editorial/i);
  assert.deepEqual(model.warnings, []);
});

test('only the run-level review endpoint is available', async () => {
  const { app, repository, storage } = createTestApp();
  const { runId, packageChecksum } = await reviewReadyRun(repository, storage, checksumA);

  const artifactRoute = await app.request(`/runs/${runId}/artifacts/asset-1/review`, {
    method: 'POST',
    headers: reviewHeaders,
    body: JSON.stringify({ decision: 'approve', packageChecksum, reviewerId: 'browser-controlled' }),
  });

  assert.equal(artifactRoute.status, 404);

  const untrustedIdentity = await app.request(`/runs/${runId}/review`, {
    method: 'POST',
    headers: reviewHeaders,
    body: JSON.stringify({ decision: 'approve', packageChecksum, reviewerId: 'browser-controlled' }),
  });
  assert.equal(untrustedIdentity.status, 400);
});

test('prepares a legacy revision only for an authenticated review principal', async () => {
  const { app, repository } = createTestApp();
  const legacyPackage = strictPackageVersionInput('0f8fad5b-d9cb-469f-a165-70867728950e', 'legacy');
  const run = await repository.createRun({
    id: legacyPackage.runId,
    title: 'Legacy review run',
    locale: 'en',
    brief: { objective: 'Historical package', notebookLmNotebookId: 'notebook-fixture' },
    notebookLmNotebookId: 'notebook-fixture',
    currentStage: 'human_review',
    packageChecksum: legacyPackage.packageChecksum,
    stages: [{ name: 'human_review', state: 'needs_human' }],
  });
  await repository.recordPackageVersion(legacyPackage);
  const body = {
    expectedRevision: 1,
    expectedPackageChecksum: legacyPackage.packageChecksum,
    notebookLmNotebookId: 'notebook-fixture',
    brief: strictLegacyReplacementBrief(),
    comment: 'Replace the unreadable legacy package with the validated baseline.',
  };
  const apiToken = await app.request(`/runs/${run.id}/prepare-legacy-revision`, {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-api-test' },
    body: JSON.stringify(body),
  });
  assert.equal(apiToken.status, 403);
  const missingPrincipal = await app.request(`/runs/${run.id}/prepare-legacy-revision`, {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-review-test' },
    body: JSON.stringify(body),
  });
  assert.equal(missingPrincipal.status, 401);
  const prepared = await app.request(`/runs/${run.id}/prepare-legacy-revision`, {
    method: 'POST',
    headers: reviewHeaders,
    body: JSON.stringify(body),
  });
  assert.equal(prepared.status, 200, await prepared.clone().text());
  const preparedBody = await prepared.json();
  assert.equal(preparedBody.run.id, run.id);
  assert.equal(preparedBody.run.currentRevision, 2);
  assert.equal(preparedBody.previousRevision, 1);
  const replay = await app.request(`/runs/${run.id}/prepare-legacy-revision`, {
    method: 'POST',
    headers: reviewHeaders,
    body: JSON.stringify(body),
  });
  assert.equal(replay.status, 200, await replay.clone().text());
  const stale = await app.request(`/runs/${run.id}/prepare-legacy-revision`, {
    method: 'POST',
    headers: reviewHeaders,
    body: JSON.stringify({ ...body, expectedRevision: 2 }),
  });
  assert.equal(stale.status, 409);
});

async function reviewReadyRun(
  repository: WorkflowRepository,
  storage: ReviewStorage,
  checksum: string,
  brief: Record<string, unknown> = { objective: 'Build one practical learner lesson.' },
): Promise<{ runId: string; packageChecksum: string }> {
  const run = await repository.bootstrapRun({
    title: 'Build a rainy day fund',
    locale: 'en',
    brief,
  });
  const capabilities = ['collect_sources', 'create_content', 'check_content', 'produce_assets'] as const;
  const fixtures = reviewStageFixtures();

  for (const capability of capabilities) {
    const claim = await repository.claimJob({ workerId: `${capability}-worker`, capabilities: [capability], leaseSeconds: 60 });
    assert.ok(claim);
    const context = await repository.getJobContext(claim.jobId);
    assert.ok(context);
    for (const artifact of fixtures[capability]) {
      const id = artifact.id ?? randomUUID();
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
        checksum: artifact.checksum ?? 'a'.repeat(64),
        storageKey,
        byteSize: body.byteLength,
        provenance: artifact.provenance ?? { provider: 'review-fixture' },
        inputChecksum: artifact.inputChecksum ?? null,
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

interface ReviewArtifactFixture {
  id?: string;
  kind: string;
  mediaType: string;
  body: string | Record<string, unknown>;
  checksum?: string;
  provenance?: Record<string, unknown>;
  inputChecksum?: string | null;
}

function reviewStageFixtures(): Record<
  'collect_sources' | 'create_content' | 'check_content' | 'produce_assets',
  ReviewArtifactFixture[]
> {
  const snapshotArtifactId = randomUUID();
  const claimId = randomUUID();
  const snapshotChecksum = 'd'.repeat(64);
  const citation = {
    sourceId,
    snapshotArtifactId,
    excerpt: 'A buffer can absorb an unexpected expense.',
  };
  const payload: NugletLessonV1Payload = {
    title: 'Build a rainy day fund',
    takeaway: 'A small buffer can reduce disruption.',
    action: 'Set aside one affordable amount today.',
    depths: {
      quick: 'Choose one amount you can set aside today.',
      core: 'Keep the first transfer small enough to repeat.',
      deep: 'Review the buffer after each unexpected expense and adjust the contribution.',
    },
    claims: [{ claimId, statement: 'A small buffer can reduce disruption.', citations: [citation] }],
    claimCoverage: [
      { path: 'title', claimIds: [claimId] },
      { path: 'takeaway', claimIds: [claimId] },
      { path: 'action', claimIds: [claimId] },
      { path: 'depths.quick', claimIds: [claimId] },
      { path: 'depths.core', claimIds: [claimId] },
      { path: 'depths.deep', claimIds: [claimId] },
    ],
  };
  const contentChecksum = calculateContentChecksum(payload);

  return {
    collect_sources: [
      {
        id: snapshotArtifactId,
        kind: 'source_snapshot',
        mediaType: 'text/html',
        body: '<article>A buffer can absorb an unexpected expense.</article>',
        checksum: snapshotChecksum,
        provenance: { provider: 'source-verifier', sourceId },
      },
      {
        kind: 'parsed_output',
        mediaType: 'application/json',
        body: {
          acceptedSources: [{
            sourceId,
            title: 'Emergency savings source',
            url: 'https://example.test/savings',
            retrievedAt: '2026-07-13T09:00:00.000Z',
            snapshotChecksum,
            readability: { passed: true, reason: null },
            credibility: { passed: true, policy: 'trusted-host', reason: null },
          }],
          rejectedSources: [],
          coverageGaps: [],
        },
      },
    ],
    create_content: [{ kind: 'parsed_output', mediaType: 'application/json', body: payload }],
    check_content: [{
      kind: 'parsed_output',
      mediaType: 'application/json',
      body: {
        deterministic: { passed: true, contentChecksum, findings: [] },
        editorial: { summary: 'Ready', findings: [] },
      },
    }],
    produce_assets: [
      { kind: 'hero', mediaType: 'image/webp', body: 'hero', inputChecksum: contentChecksum },
      { kind: 'infographic', mediaType: 'image/webp', body: 'infographic', inputChecksum: contentChecksum },
      { kind: 'audio_brief', mediaType: 'audio/mp4', body: 'brief audio', inputChecksum: contentChecksum },
      { kind: 'audio_discussion', mediaType: 'audio/mp4', body: 'discussion audio', inputChecksum: contentChecksum },
    ],
  };
}

async function finishRevisionFromCreate(
  repository: WorkflowRepository,
  storage: ReviewStorage,
  create: JobClaim,
  priorPackage: NonNullable<Awaited<ReturnType<WorkflowRepository['getPackageVersion']>>>,
): Promise<void> {
  const contentChecksum = calculateContentChecksum(priorPackage.content.target.payload);
  await recordClaimArtifacts(repository, storage, create, 'create-worker', [{
    kind: 'parsed_output',
    mediaType: 'application/json',
    body: priorPackage.content.target.payload,
  }]);
  await completeClaim(repository, create, 'create-worker');
  const check = await requiredClaim(repository, 'check_content', 'check-worker');
  await recordClaimArtifacts(repository, storage, check, 'check-worker', [{
    kind: 'parsed_output',
    mediaType: 'application/json',
    body: priorPackage.qa,
  }]);
  await completeClaim(repository, check, 'check-worker');
  const assets = await requiredClaim(repository, 'produce_assets', 'asset-worker');
  await recordClaimArtifacts(repository, storage, assets, 'asset-worker', [
    { kind: 'hero', mediaType: 'image/webp', body: 'revised hero', inputChecksum: contentChecksum },
    { kind: 'infographic', mediaType: 'image/webp', body: 'revised infographic', inputChecksum: contentChecksum },
    { kind: 'audio_brief', mediaType: 'audio/mp4', body: 'revised brief audio', inputChecksum: contentChecksum },
    { kind: 'audio_discussion', mediaType: 'audio/mp4', body: 'revised discussion audio', inputChecksum: contentChecksum },
  ]);
  await completeClaim(repository, assets, 'asset-worker');
}

async function requiredClaim(
  repository: WorkflowRepository,
  capability: string,
  workerId: string,
): Promise<JobClaim> {
  const claim = await repository.claimJob({ workerId, capabilities: [capability], leaseSeconds: 60 });
  assert.ok(claim, `expected ${capability} claim`);
  return claim;
}

async function recordClaimArtifacts(
  repository: WorkflowRepository,
  storage: ReviewStorage,
  claim: JobClaim,
  workerId: string,
  artifacts: readonly ReviewArtifactFixture[],
): Promise<void> {
  for (const artifact of artifacts) {
    const id = artifact.id ?? randomUUID();
    const storageKey = `revision-fixture/${claim.packageId}/${claim.revision}/${claim.stage}/${id}`;
    const body = typeof artifact.body === 'string'
      ? Buffer.from(artifact.body)
      : Buffer.from(JSON.stringify(artifact.body));
    storage.objects.set(storageKey, body);
    await repository.recordArtifactForActiveLease({
      workerId,
      jobId: claim.jobId,
      id,
      runId: claim.packageId,
      revision: claim.revision,
      kind: artifact.kind,
      mediaType: artifact.mediaType,
      checksum: artifact.checksum ?? 'e'.repeat(64),
      storageKey,
      byteSize: body.byteLength,
      provenance: artifact.provenance ?? { provider: 'revision-fixture' },
      inputChecksum: artifact.inputChecksum ?? null,
    });
  }
}

async function completeClaim(
  repository: WorkflowRepository,
  claim: JobClaim,
  workerId: string,
): Promise<void> {
  const context = await repository.getJobContext(claim.jobId);
  assert.ok(context);
  await repository.applyJobResult({
    workerId,
    result: {
      jobId: claim.jobId,
      packageId: claim.packageId,
      stage: claim.stage,
      state: 'done',
      completedAt: '2026-07-13T10:10:00.000Z',
      outputChecksum: 'e'.repeat(64),
      error: null,
    },
    transition: nextTransition({
      stage: context.stage.name,
      state: context.stage.state,
      revisionAttempts: context.stage.revisionAttempts,
      packageChecksum: context.packageChecksum as `${string}` | null,
      approvedChecksum: context.approvedChecksum as `${string}` | null,
      reason: context.stage.reason ?? undefined,
    }, { type: 'stage_completed', packageChecksum: 'e'.repeat(64) as `${string}` }),
  });
}
