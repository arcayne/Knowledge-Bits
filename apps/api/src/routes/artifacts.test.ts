import assert from 'node:assert/strict';
import test from 'node:test';

import type { ArtifactStorageAdapter } from '../services/artifacts.js';
import { createApp } from '../app.js';
import {
  createInMemoryWorkflowStore,
  WorkflowRepository,
} from '../repositories/workflow-repository.js';

const runId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const checksum = 'a'.repeat(64);
const otherChecksum = 'b'.repeat(64);

class FixtureArtifactStorageAdapter implements ArtifactStorageAdapter {
  readonly objects = new Map<string, { checksum: string; byteSize: number; mediaType: string }>();

  async preparePut(input: { storageKey: string; mediaType: string; expiresInSeconds: number }) {
    return {
      uploadUrl: `https://fixture.invalid/upload/${input.storageKey}`,
      requiredHeaders: { 'content-type': input.mediaType },
    };
  }

  async inspect(storageKey: string) {
    const object = this.objects.get(storageKey);
    if (!object) throw new Error('Fixture object does not exist');
    return object;
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
      ]),
    },
  });

  return {
    app,
    storage,
    setNow(value: Date) {
      now = new Date(value);
    },
    async queueArtifactJob() {
      await repository.createRun({
        id: runId,
        title: 'Artifact upload',
        locale: 'en',
        brief: { objective: 'Create a visual artifact' },
        currentStage: 'produce_assets',
        stages: [{ name: 'produce_assets', state: 'queued' }],
      });
      const job = await repository.queueJob({
        runId,
        stage: 'produce_assets',
        action: 'produce_assets',
        idempotencyKey: 'artifact-upload-job',
        input: { kind: 'evidence' },
      });
      return job;
    },
  };
}

async function claimArtifactJob(app: ReturnType<typeof createFixture>['app']) {
  const response = await app.request('/jobs/claim', {
    method: 'POST',
    headers: { Authorization: 'Bearer asset-worker-token' },
    body: JSON.stringify({ leaseSeconds: 120 }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json() as Promise<{ jobId: string }>;
}

async function prepareArtifact(
  app: ReturnType<typeof createFixture>['app'],
  jobId: string,
  extra: Record<string, unknown> = {},
) {
  const response = await app.request('/artifacts/prepare', {
    method: 'POST',
    headers: { Authorization: 'Bearer asset-worker-token' },
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

function completionBody(jobId: string, prepared: { artifactId: string }) {
  return {
    jobId,
    artifactId: prepared.artifactId,
    runId,
    revision: 1,
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
  assert.match(body.storageKey, new RegExp(`^knowledge-bits/${runId}/1/${body.artifactId}$`));
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
