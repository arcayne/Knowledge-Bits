import assert from 'node:assert/strict';
import test from 'node:test';

import {
  artifactStorageKey,
  ArtifactStorageObjectNotFoundError,
  ArtifactStorageOperationError,
  type ArtifactStorageAdapter,
} from '../services/artifacts.js';
import { createApp } from '../app.js';
import {
  createInMemoryWorkflowStore,
  WorkflowRepository,
} from '../repositories/workflow-repository.js';
import type { WorkflowStage } from '@knowledge-bits/contracts';

const runId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const checksum = 'a'.repeat(64);
const otherChecksum = 'b'.repeat(64);

class FixtureArtifactStorageAdapter implements ArtifactStorageAdapter {
  readonly objects = new Map<string, { checksum: string; byteSize: number; mediaType: string }>();
  inspectError: Error | null = null;
  onInspect: (() => void) | null = null;

  async preparePut(input: { storageKey: string; mediaType: string; expiresInSeconds: number }) {
    return {
      uploadUrl: `https://fixture.invalid/upload/${input.storageKey}`,
      requiredHeaders: { 'content-type': input.mediaType },
    };
  }

  async inspect(storageKey: string) {
    this.onInspect?.();
    if (this.inspectError) throw this.inspectError;
    const object = this.objects.get(storageKey);
    if (!object) throw new ArtifactStorageObjectNotFoundError('Fixture object does not exist');
    return object;
  }

  async read(): Promise<Uint8Array> {
    throw new Error('not used');
  }
}

function createFixture() {
  let now = new Date('2026-07-12T12:00:00.000Z');
  const repository = new WorkflowRepository(createInMemoryWorkflowStore({
    clock: () => new Date(now),
  }));
  const storage = new FixtureArtifactStorageAdapter();
  const app = createApp({
    repository,
    artifactStorage: storage,
    env: {
      ENGINE_API_TOKEN: 'engine-api-test',
      ENGINE_REVIEW_TOKEN: 'engine-review-test',
      ENGINE_WORKER_CREDENTIALS: JSON.stringify([
        { token: 'asset-worker-token', workerId: 'asset-worker', capabilities: ['produce_assets'] },
        { token: 'other-worker-token', workerId: 'other-worker', capabilities: ['produce_assets'] },
        { token: 'research-worker-token', workerId: 'research-worker', capabilities: ['collect_sources'] },
        { token: 'create-worker-token', workerId: 'create-worker', capabilities: ['create_content'] },
        { token: 'check-worker-token', workerId: 'check-worker', capabilities: ['check_content'] },
        { token: 'delivery-worker-token', workerId: 'delivery-worker', capabilities: ['deliver_package'] },
      ]),
    },
  });

  return {
    app,
    repository,
    storage,
    setNow(value: Date) {
      now = new Date(value);
    },
    async queueArtifactJob({
      stage = 'produce_assets',
      action = 'produce_assets',
      currentRevision = 1,
    }: {
      stage?: WorkflowStage;
      action?: string;
      currentRevision?: number;
    } = {}) {
      await repository.createRun({
        id: runId,
        title: 'Artifact upload',
        locale: 'en',
        brief: { objective: 'Create a visual artifact' },
        currentStage: stage,
        currentRevision,
        ...(stage === 'deliver' ? {
          packageChecksum: checksum,
          approvedChecksum: checksum,
          reviewStatus: 'approved' as const,
        } : {}),
        stages: [{ name: stage, state: 'queued' }],
      });
      const job = await repository.queueJob({
        runId,
        stage,
        action,
        idempotencyKey: `artifact-upload-job:${action}`,
        input: {
          kind: 'evidence',
          ...(stage === 'deliver' ? {
            deliveryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            packageVersionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            packageChecksum: checksum,
          } : {}),
        },
      });
      return job;
    },
  };
}

async function claimArtifactJob(
  app: ReturnType<typeof createFixture>['app'],
  workerToken = 'asset-worker-token',
) {
  const response = await app.request('/jobs/claim', {
    method: 'POST',
    headers: { Authorization: `Bearer ${workerToken}` },
    body: JSON.stringify({ leaseSeconds: 120 }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json() as Promise<{ jobId: string }>;
}

async function prepareArtifact(
  app: ReturnType<typeof createFixture>['app'],
  jobId: string,
  extra: Record<string, unknown> = {},
  workerToken = 'asset-worker-token',
) {
  const response = await app.request('/artifacts/prepare', {
    method: 'POST',
    headers: { Authorization: `Bearer ${workerToken}` },
    body: JSON.stringify({
      jobId,
      runId,
      revision: 1,
      kind: 'evidence',
      mediaType: 'application/json',
      ...extra,
    }),
  });
  return response;
}

function completionBody(jobId: string, prepared: { artifactId: string }, revision = 1) {
  return {
    jobId,
    artifactId: prepared.artifactId,
    runId,
    revision,
    kind: 'evidence',
    mediaType: 'application/json',
    checksum,
    byteSize: 42,
    provider: 'fixture',
    inputChecksum: null,
    provenance: { job: 'produce_assets' },
  };
}

test('prepare derives the storage key on the server', async () => {
  const fixture = createFixture();
  await fixture.queueArtifactJob();
  const claim = await claimArtifactJob(fixture.app);

  const response = await prepareArtifact(fixture.app, claim.jobId);
  assert.equal(response.status, 201, await response.clone().text());
  const body = await response.json() as { artifactId: string; storageKey: string; requiredHeaders: Record<string, string> };
  assert.match(body.storageKey, new RegExp(`^knowledge-bits/nuglet/${runId}/1/${body.artifactId}$`));
  assert.equal(body.storageKey.includes('users/'), false);
  assert.deepEqual(body.requiredHeaders, { 'content-type': 'application/json' });
});

test('rejects caller-supplied storage keys and malformed artifact input', async () => {
  const fixture = createFixture();
  await fixture.queueArtifactJob();
  const claim = await claimArtifactJob(fixture.app);

  const prepared = await prepareArtifact(fixture.app, claim.jobId, { storageKey: 'users/attacker/object' });
  assert.equal(prepared.status, 400);

  const malformed = await fixture.app.request('/artifacts/complete', {
    method: 'POST',
    headers: { Authorization: 'Bearer asset-worker-token' },
    body: '{',
  });
  assert.equal(malformed.status, 400);

  const completionWithStorageKey = await fixture.app.request('/artifacts/complete', {
    method: 'POST',
    headers: { Authorization: 'Bearer asset-worker-token' },
    body: JSON.stringify({
      ...completionBody(claim.jobId, { artifactId: '4a3f4c12-5139-4e1d-8ca0-971d380cb8a7' }),
      storageKey: 'users/attacker/object',
    }),
  });
  assert.equal(completionWithStorageKey.status, 400);
});

test('requires an authenticated worker with the producing job lease', async () => {
  const fixture = createFixture();
  const job = await fixture.queueArtifactJob();

  const missingAuth = await fixture.app.request('/artifacts/prepare', {
    method: 'POST',
    body: JSON.stringify({ jobId: job.id, runId, revision: 1, kind: 'evidence', mediaType: 'application/json' }),
  });
  assert.equal(missingAuth.status, 401);

  const wrongScope = await fixture.app.request('/artifacts/prepare', {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-api-test' },
    body: JSON.stringify({ jobId: job.id, runId, revision: 1, kind: 'evidence', mediaType: 'application/json' }),
  });
  assert.equal(wrongScope.status, 403);

  const unclaimed = await prepareArtifact(fixture.app, job.id);
  assert.equal(unclaimed.status, 409);

  const claim = await claimArtifactJob(fixture.app);
  const otherWorker = await fixture.app.request('/artifacts/prepare', {
    method: 'POST',
    headers: { Authorization: 'Bearer other-worker-token' },
    body: JSON.stringify({ jobId: claim.jobId, runId, revision: 1, kind: 'evidence', mediaType: 'application/json' }),
  });
  assert.equal(otherWorker.status, 409);

  fixture.setNow(new Date('2026-07-12T12:03:00.000Z'));
  const expired = await prepareArtifact(fixture.app, claim.jobId);
  assert.equal(expired.status, 409);
});

test('permits audit artifacts for each automated lease but keeps other artifacts asset-only', async () => {
  const nonProducerJobs = [
    { stage: 'research', action: 'collect_sources', token: 'research-worker-token' },
    { stage: 'create', action: 'create_content', token: 'create-worker-token' },
    { stage: 'check', action: 'check_content', token: 'check-worker-token' },
    { stage: 'deliver', action: 'deliver_package', token: 'delivery-worker-token' },
  ] as const;

  for (const nonProducer of nonProducerJobs) {
    const fixture = createFixture();
    const job = await fixture.queueArtifactJob(nonProducer);
    await claimArtifactJob(fixture.app, nonProducer.token);

    for (const kind of [
      'raw_response',
      'execution_report',
      'generation.recipe.snapshot',
      'generation.prompt.rendered',
      'generation.execution.report',
    ]) {
      const preparedResponse = await prepareArtifact(
        fixture.app,
        job.id,
        { kind },
        nonProducer.token,
      );
      assert.equal(preparedResponse.status, 201, `${kind}: ${await preparedResponse.clone().text()}`);
      const prepared = await preparedResponse.json() as { artifactId: string; storageKey: string };
      fixture.storage.objects.set(prepared.storageKey, { checksum, byteSize: 42, mediaType: 'application/json' });

      const completed = await fixture.app.request('/artifacts/complete', {
        method: 'POST',
        headers: { Authorization: `Bearer ${nonProducer.token}` },
        body: JSON.stringify({ ...completionBody(job.id, prepared), kind }),
      });
      assert.equal(completed.status, 201, `${kind}: ${await completed.clone().text()}`);
    }

    const nonAuditArtifact = await prepareArtifact(fixture.app, job.id, {}, nonProducer.token);
    assert.equal(nonAuditArtifact.status, 409, `${nonProducer.action} prepared a non-audit artifact`);
  }
});

test('rejects stale and future revisions in artifact prepare and completion', async () => {
  const fixture = createFixture();
  const job = await fixture.queueArtifactJob({ currentRevision: 2 });
  const claim = await claimArtifactJob(fixture.app);
  const artifactId = '4a3f4c12-5139-4e1d-8ca0-971d380cb8a7';

  for (const revision of [1, 3]) {
    const prepared = await prepareArtifact(fixture.app, claim.jobId, { revision });
    assert.equal(prepared.status, 409, `prepare accepted revision ${revision}`);

    fixture.storage.objects.set(artifactStorageKey(runId, revision, artifactId), {
      checksum,
      byteSize: 42,
      mediaType: 'application/json',
    });
    const completed = await fixture.app.request('/artifacts/complete', {
      method: 'POST',
      headers: { Authorization: 'Bearer asset-worker-token' },
      body: JSON.stringify(completionBody(job.id, { artifactId }, revision)),
    });
    assert.equal(completed.status, 409, `completion accepted revision ${revision}`);
  }
});

test('rejects completion metadata that differs from storage inspection', async () => {
  const fixture = createFixture();
  await fixture.queueArtifactJob();
  const claim = await claimArtifactJob(fixture.app);

  for (const [field, value] of [
    ['checksum', otherChecksum],
    ['byteSize', 41],
    ['mediaType', 'image/webp'],
  ] as const) {
    const preparedResponse = await prepareArtifact(fixture.app, claim.jobId);
    assert.equal(preparedResponse.status, 201);
    const prepared = await preparedResponse.json() as { artifactId: string; storageKey: string };
    fixture.storage.objects.set(prepared.storageKey, { checksum, byteSize: 42, mediaType: 'application/json' });

    const response = await fixture.app.request('/artifacts/complete', {
      method: 'POST',
      headers: { Authorization: 'Bearer asset-worker-token' },
      body: JSON.stringify({ ...completionBody(claim.jobId, prepared), [field]: value }),
    });
    assert.equal(response.status, 422, await response.clone().text());
  }
});

test('records inspected metadata once and maps repository conflicts to immutable completion', async () => {
  const fixture = createFixture();
  await fixture.queueArtifactJob();
  const claim = await claimArtifactJob(fixture.app);
  const preparedResponse = await prepareArtifact(fixture.app, claim.jobId);
  assert.equal(preparedResponse.status, 201);
  const prepared = await preparedResponse.json() as { artifactId: string; storageKey: string };
  fixture.storage.objects.set(prepared.storageKey, { checksum, byteSize: 42, mediaType: 'application/json' });

  const request = {
    method: 'POST',
    headers: { Authorization: 'Bearer asset-worker-token' },
    body: JSON.stringify(completionBody(claim.jobId, prepared)),
  };
  const first = await fixture.app.request('/artifacts/complete', request);
  assert.equal(first.status, 201, await first.clone().text());
  const body = await first.json() as { checksum: string; byteSize: number; mediaType: string; storageKey: string };
  assert.equal(body.checksum, checksum);
  assert.equal(body.byteSize, 42);
  assert.equal(body.mediaType, 'application/json');
  assert.equal(body.storageKey, prepared.storageKey);

  const duplicate = await fixture.app.request('/artifacts/complete', request);
  assert.equal(duplicate.status, 409);
});

test('derives artifact action and job identity from the authenticated lease', async () => {
  const fixture = createFixture();
  const job = await fixture.queueArtifactJob({ stage: 'research', action: 'collect_sources' });
  const claim = await claimArtifactJob(fixture.app, 'research-worker-token');
  const preparedResponse = await prepareArtifact(
    fixture.app,
    claim.jobId,
    { kind: 'parsed_output' },
    'research-worker-token',
  );
  assert.equal(preparedResponse.status, 201);
  const prepared = await preparedResponse.json() as { artifactId: string; storageKey: string };
  fixture.storage.objects.set(prepared.storageKey, { checksum, byteSize: 42, mediaType: 'application/json' });

  const completed = await fixture.app.request('/artifacts/complete', {
    method: 'POST',
    headers: { Authorization: 'Bearer research-worker-token' },
    body: JSON.stringify({
      ...completionBody(job.id, prepared),
      kind: 'parsed_output',
      provenance: {
        action: 'create_content',
        jobId: '99999999-9999-4999-8999-999999999999',
        stage: 'create',
      },
    }),
  });
  assert.equal(completed.status, 201, await completed.clone().text());

  const [artifact] = await fixture.repository.listArtifacts(runId, 1);
  assert.equal(artifact?.provenance.action, 'collect_sources');
  assert.equal(artifact?.provenance.stage, 'research');
  assert.equal(artifact?.provenance.jobId, job.id);

  await fixture.repository.completeJob({
    workerId: 'research-worker',
    result: {
      jobId: job.id,
      packageId: runId,
      stage: 'research',
      state: 'done',
      completedAt: '2026-07-12T12:00:30.000Z',
      outputChecksum: checksum,
      error: null,
    },
  });
  const successful = await fixture.repository.listArtifactsForSuccessfulStageJobs(runId, 1);
  assert.deepEqual(successful.map((candidate) => candidate.id), [prepared.artifactId]);
  assert.equal(successful[0]?.action, 'collect_sources');
  assert.equal(successful[0]?.jobId, job.id);
});

test('rechecks the producer lease after storage inspection before recording an artifact', async () => {
  const fixture = createFixture();
  await fixture.queueArtifactJob();
  const claim = await claimArtifactJob(fixture.app);
  const preparedResponse = await prepareArtifact(fixture.app, claim.jobId);
  assert.equal(preparedResponse.status, 201);
  const prepared = await preparedResponse.json() as { artifactId: string; storageKey: string };
  fixture.storage.objects.set(prepared.storageKey, { checksum, byteSize: 42, mediaType: 'application/json' });
  fixture.storage.onInspect = () => fixture.setNow(new Date('2026-07-12T12:02:00.000Z'));

  const response = await fixture.app.request('/artifacts/complete', {
    method: 'POST',
    headers: { Authorization: 'Bearer asset-worker-token' },
    body: JSON.stringify(completionBody(claim.jobId, prepared)),
  });

  assert.equal(response.status, 409, await response.clone().text());
});

test('maps a missing uploaded object to a client error and storage failures to 503', async () => {
  const fixture = createFixture();
  await fixture.queueArtifactJob();
  const claim = await claimArtifactJob(fixture.app);
  const preparedResponse = await prepareArtifact(fixture.app, claim.jobId);
  assert.equal(preparedResponse.status, 201);
  const prepared = await preparedResponse.json() as { artifactId: string; storageKey: string };

  const missing = await fixture.app.request('/artifacts/complete', {
    method: 'POST',
    headers: { Authorization: 'Bearer asset-worker-token' },
    body: JSON.stringify(completionBody(claim.jobId, prepared)),
  });
  assert.equal(missing.status, 404, await missing.clone().text());

  fixture.storage.inspectError = new ArtifactStorageOperationError('Fixture storage is unavailable');
  const unavailable = await fixture.app.request('/artifacts/complete', {
    method: 'POST',
    headers: { Authorization: 'Bearer asset-worker-token' },
    body: JSON.stringify(completionBody(claim.jobId, prepared)),
  });
  assert.equal(unavailable.status, 503, await unavailable.clone().text());
});
