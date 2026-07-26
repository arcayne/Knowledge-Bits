import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { createApp } from '../app.js';
import {
  createInMemoryWorkflowStore,
  WorkflowRepository,
} from '../repositories/workflow-repository.js';
import {
  DeliveryPermanentSchemaError,
  DeliveryTransientError,
} from '../services/delivery.js';
import type { DeliveryAdapter } from '../services/delivery-adapters/types.js';
import { strictPackageVersionInput } from '../testing/knowledge-bits-fixture.js';

test('the queued delivery action runs the delivery service instead of a fixture provider', async () => {
  const fixture = await routeFixture();
  const claim = await claimDelivery(fixture.app);

  const response = await fixture.app.request(`/deliveries/${claim.deliveryId}/run`, {
    method: 'POST',
    headers: { Authorization: 'Bearer delivery-worker-token' },
    body: JSON.stringify({ jobId: claim.jobId }),
  });

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json() as { state: string }).state, 'succeeded');
  assert.equal(fixture.adapter.requests, 1);
  assert.equal((await fixture.repository.getRun(fixture.runId))?.stages.deliver?.state, 'done');
});

test('review-token retry permits failed delivery with unchanged approval and rejects conflicting retries', async () => {
  const fixture = await routeFixture();
  fixture.adapter.failure = new DeliveryTransientError('destination_timeout');
  const claim = await claimDelivery(fixture.app);
  const run = await fixture.app.request(`/deliveries/${claim.deliveryId}/run`, {
    method: 'POST',
    headers: { Authorization: 'Bearer delivery-worker-token' },
    body: JSON.stringify({ jobId: claim.jobId }),
  });
  assert.equal(run.status, 202, await run.clone().text());

  const unauthorized = await fixture.app.request(`/deliveries/${claim.deliveryId}/retry`, { method: 'POST' });
  assert.equal(unauthorized.status, 401);

  const retried = await fixture.app.request(`/deliveries/${claim.deliveryId}/retry`, {
    method: 'POST',
    headers: { Authorization: 'Bearer review-token' },
  });
  assert.equal(retried.status, 200, await retried.clone().text());
  const body = await retried.json() as { deliveryId: string; nextAttempt: number };
  assert.equal(body.deliveryId, claim.deliveryId);
  assert.equal(body.nextAttempt, 2);

  const conflict = await fixture.app.request(`/deliveries/${claim.deliveryId}/retry`, {
    method: 'POST',
    headers: { Authorization: 'Bearer review-token' },
  });
  assert.equal(conflict.status, 409);
});

test('review-token retry recovers a human-blocked delivery after configuration is fixed', async () => {
  const fixture = await routeFixture();
  fixture.adapter.failure = new DeliveryPermanentSchemaError('destination_configuration_missing');
  const firstClaim = await claimDelivery(fixture.app);
  const blocked = await fixture.app.request(`/deliveries/${firstClaim.deliveryId}/run`, {
    method: 'POST',
    headers: { Authorization: 'Bearer delivery-worker-token' },
    body: JSON.stringify({ jobId: firstClaim.jobId }),
  });
  assert.equal(blocked.status, 202, await blocked.clone().text());
  assert.equal(
    (await fixture.repository.getDelivery(firstClaim.deliveryId))?.state,
    'needs_human',
  );

  fixture.adapter.failure = undefined;
  const retried = await fixture.app.request(`/deliveries/${firstClaim.deliveryId}/retry`, {
    method: 'POST',
    headers: { Authorization: 'Bearer review-token' },
  });
  assert.equal(retried.status, 200, await retried.clone().text());
  assert.equal(
    (await fixture.repository.getDelivery(firstClaim.deliveryId))?.state,
    'waiting',
  );

  const secondClaim = await claimDelivery(fixture.app);
  assert.equal(secondClaim.deliveryId, firstClaim.deliveryId);
  const recovered = await fixture.app.request(`/deliveries/${secondClaim.deliveryId}/run`, {
    method: 'POST',
    headers: { Authorization: 'Bearer delivery-worker-token' },
    body: JSON.stringify({ jobId: secondClaim.jobId }),
  });
  assert.equal(recovered.status, 200, await recovered.clone().text());
  assert.equal((await recovered.json() as { state: string }).state, 'succeeded');
});

test('retry rejects a delivery after the approved checksum changes', async () => {
  const fixture = await routeFixture();
  fixture.adapter.verifyMatches = false;
  const claim = await claimDelivery(fixture.app);
  await fixture.app.request(`/deliveries/${claim.deliveryId}/run`, {
    method: 'POST',
    headers: { Authorization: 'Bearer delivery-worker-token' },
    body: JSON.stringify({ jobId: claim.jobId }),
  });
  await fixture.repository.recordPackageVersion(packageVersionInput(fixture.runId, 'B'));

  const response = await fixture.app.request(`/deliveries/${claim.deliveryId}/retry`, {
    method: 'POST',
    headers: { Authorization: 'Bearer review-token' },
  });

  assert.equal(response.status, 409);
});

class RouteAdapter implements DeliveryAdapter {
  requests = 0;
  failure?: Error;
  verifyMatches = true;

  async deliver() {
    this.requests += 1;
    if (this.failure) throw this.failure;
    return { externalId: 'external-1', previewUrl: 'https://delivery.example.test/1', status: 'imported' as const };
  }

  async verify() {
    return { matches: this.verifyMatches, url: 'https://delivery.example.test/1' };
  }
}

async function routeFixture() {
  const repository = new WorkflowRepository(createInMemoryWorkflowStore());
  const runId = randomUUID();
  await repository.createRun({
    id: runId,
    title: 'Route delivery',
    locale: 'en',
    brief: {},
    currentStage: 'human_review',
    stages: [{ name: 'human_review', state: 'needs_human' }],
  });
  const packageVersion = await repository.recordPackageVersion(packageVersionInput(runId, 'A'));
  await repository.reviewRun({
    runId,
    packageChecksum: packageVersion.packageChecksum,
    decision: 'approve',
    reviewerId: 'editor-1',
  });
  const adapter = new RouteAdapter();
  const app = createApp({
    repository,
    deliveryAdapter: adapter,
    env: {
      ENGINE_API_TOKEN: 'api-token',
      ENGINE_REVIEW_TOKEN: 'review-token',
      ENGINE_WORKER_CREDENTIALS: JSON.stringify([{
        token: 'delivery-worker-token',
        workerId: 'delivery-worker',
        capabilities: ['deliver_package'],
      }]),
    },
  });
  return { adapter, app, repository, runId };
}

async function claimDelivery(app: ReturnType<typeof createApp>) {
  const response = await app.request('/jobs/claim', {
    method: 'POST',
    headers: { Authorization: 'Bearer delivery-worker-token' },
    body: JSON.stringify({ leaseSeconds: 120 }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json() as Promise<{ jobId: string; deliveryId: string }>;
}

function packageVersionInput(runId: string, variant: string) {
  return strictPackageVersionInput(runId, variant);
}
