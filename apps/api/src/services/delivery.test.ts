import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { calculatePackageChecksum } from '@knowledge-bits/pipeline';

import {
  createInMemoryWorkflowStore,
  type RecordPackageVersionInput,
  WorkflowConflictError,
  WorkflowRepository,
} from '../repositories/workflow-repository.js';
import {
  DeliveryPermanentSchemaError,
  DeliveryService,
  DeliveryTransientError,
} from './delivery.js';
import type {
  DeliveryAdapter,
  DeliveryAdapterInput,
  DeliveryAdapterResponse,
} from './delivery-adapters/types.js';

test('approve A delivers the exact immutable package and persists the adapter response before verification', async () => {
  const fixture = await approvedFixture('A');
  fixture.adapter.onVerify = async () => {
    const persisted = await fixture.repository.getDelivery(fixture.deliveryId);
    assert.equal(persisted?.response?.externalId, 'external-A');
  };

  const result = await fixture.service.run(fixture.deliveryId, fixture.execution);

  assert.equal(result.state, 'succeeded');
  assert.equal(fixture.adapter.requests[0]?.knowledgeBits.id, fixture.packageVersion.id);
  assert.equal(fixture.adapter.requests[0]?.knowledgeBits.packageChecksum, fixture.packageVersion.packageChecksum);
  assert.equal(fixture.adapter.requests[0]?.packageChecksum, fixture.packageVersion.packageChecksum);
  assert.equal((await fixture.repository.getDelivery(fixture.deliveryId))?.state, 'succeeded');
});

test('scheduled transient retry preserves immutable package identity and external idempotency', async () => {
  const fixture = await approvedFixture('A');
  fixture.adapter.failures.push(new DeliveryTransientError('destination_timeout'));

  const first = await fixture.service.run(fixture.deliveryId, fixture.execution);
  await fixture.finishAttempt(first);
  assert.equal(first.state, 'waiting');
  assert.ok(first.retryAt > new Date('2026-07-13T10:00:00.000Z'));

  fixture.advanceClock(60_000);
  const retryExecution = await fixture.claim();
  fixture.adapter.nextStatus = 'already_imported';
  const second = await fixture.service.run(fixture.deliveryId, retryExecution);

  assert.equal(second.state, 'succeeded');
  assert.equal(fixture.adapter.requests[0]?.knowledgeBits.id, fixture.adapter.requests[1]?.knowledgeBits.id);
  assert.equal(fixture.adapter.requests[0]?.packageChecksum, fixture.adapter.requests[1]?.packageChecksum);
  assert.equal(fixture.adapter.requests[0]?.idempotencyKey, fixture.adapter.requests[1]?.idempotencyKey);
});

test('invalidating A and approving B creates a different immutable delivery and external key', async () => {
  const fixture = await approvedFixture('A');
  await fixture.service.run(fixture.deliveryId, fixture.execution);
  const packageB = await fixture.repository.recordPackageVersion(packageVersionInput(fixture.runId, 'B'));
  await fixture.repository.reviewRun({
    runId: fixture.runId,
    packageChecksum: packageB.packageChecksum,
    decision: 'approve',
    reviewerId: 'editor-1',
  });
  const deliveryB = await fixture.repository.getDeliveryForPackage(fixture.runId, packageB.packageChecksum);
  assert.ok(deliveryB);

  const executionB = await fixture.claim();
  await fixture.service.run(deliveryB.id, executionB);

  assert.notEqual(deliveryB.id, fixture.deliveryId);
  assert.notEqual(deliveryB.packageVersionId, fixture.packageVersion.id);
  assert.notEqual(deliveryB.idempotencyKey, (await fixture.repository.getDelivery(fixture.deliveryId))?.idempotencyKey);
  assert.equal(fixture.adapter.requests[1]?.knowledgeBits.id, packageB.id);
  assert.equal(fixture.adapter.requests[1]?.packageChecksum, packageB.packageChecksum);
});

test('rejects delivery without a matching current approval', async () => {
  const repository = new WorkflowRepository(createInMemoryWorkflowStore());
  const runId = randomUUID();
  await repository.createRun({
    id: runId,
    title: 'Unapproved package',
    locale: 'en',
    brief: {},
    currentStage: 'human_review',
    stages: [{ name: 'human_review', state: 'needs_human' }],
  });
  const packageVersion = await repository.recordPackageVersion(packageVersionInput(runId, 'A'));
  const delivery = await repository.recordDelivery({
    runId,
    packageVersionId: packageVersion.id,
    target: 'nuglet.lesson.v1',
    packageChecksum: packageVersion.packageChecksum,
    idempotencyKey: 'unapproved-delivery',
    state: 'queued',
  });
  const adapter = new RecordingAdapter();

  await assert.rejects(new DeliveryService({ repository, adapter }).run(delivery.id, {
    jobId: randomUUID(),
    workerId: 'delivery-worker',
  }), /approved checksum/i);
  assert.equal(adapter.requests.length, 0);
});

test('transient, permanent schema, and verification failures preserve the immutable package', async () => {
  const transient = await approvedFixture('transient');
  transient.adapter.failures.push(new DeliveryTransientError('destination_unavailable'));
  assert.equal((await transient.service.run(transient.deliveryId, transient.execution)).state, 'waiting');
  assert.equal((await transient.repository.getDelivery(transient.deliveryId))?.state, 'waiting');

  const permanent = await approvedFixture('permanent');
  permanent.adapter.failures.push(new DeliveryPermanentSchemaError('destination_schema_rejected'));
  assert.equal((await permanent.service.run(permanent.deliveryId, permanent.execution)).state, 'needs_human');
  assert.equal((await permanent.repository.getDelivery(permanent.deliveryId))?.state, 'needs_human');

  const verify = await approvedFixture('verify');
  verify.adapter.verifyMatches = false;
  assert.equal((await verify.service.run(verify.deliveryId, verify.execution)).state, 'failed');
  const failed = await verify.repository.getDelivery(verify.deliveryId);
  assert.equal(failed?.response?.externalId, 'external-verify');
  assert.equal(failed?.packageVersionId, verify.packageVersion.id);
  assert.equal(verify.adapter.requests.length, 1);

  const verifyError = await approvedFixture('verify-error');
  verifyError.adapter.verifyFailure = new DeliveryTransientError('verification_timeout');
  assert.equal((await verifyError.service.run(verifyError.deliveryId, verifyError.execution)).state, 'waiting');
  assert.equal((await verifyError.repository.getDelivery(verifyError.deliveryId))?.response?.externalId, 'external-verify-error');
});

test('package supersession during deliver preserves the late adapter response without reviving the delivery', async () => {
  const fixture = await approvedFixture('superseded');
  let releaseDeliver!: () => void;
  fixture.adapter.deliverBarrier = new Promise<void>((resolve) => { releaseDeliver = resolve; });
  const running = fixture.service.run(fixture.deliveryId, fixture.execution);
  await fixture.adapter.deliverStarted;

  await fixture.repository.recordPackageVersion(packageVersionInput(fixture.runId, 'replacement'));
  releaseDeliver();

  await assert.rejects(running, WorkflowConflictError);
  const delivery = await fixture.repository.getDelivery(fixture.deliveryId);
  assert.equal(delivery?.state, 'superseded');
  assert.equal(delivery?.response?.externalId, 'external-superseded');
  assert.equal((delivery?.response?.lateEvidence as unknown[] | undefined)?.length, 1);
  assert.equal(fixture.adapter.verifyRequests, 0);
});

test('lease loss during verify preserves verification evidence without advancing the delivery', async () => {
  const fixture = await approvedFixture('lease-loss');
  fixture.adapter.onVerify = async () => fixture.advanceClock(61_000);

  await assert.rejects(
    fixture.service.run(fixture.deliveryId, fixture.execution),
    WorkflowConflictError,
  );

  const delivery = await fixture.repository.getDelivery(fixture.deliveryId);
  assert.equal(delivery?.state, 'verifying');
  assert.equal((delivery?.response?.verification as { matches?: boolean } | undefined)?.matches, true);
  assert.equal((delivery?.response?.lateEvidence as unknown[] | undefined)?.length, 1);
});

test('terminal and superseded deliveries cannot be run automatically', async () => {
  const fixtures = await Promise.all([
    approvedFixture('terminal-needs-human'),
    approvedFixture('terminal-succeeded'),
    approvedFixture('terminal-superseded'),
  ]);
  fixtures[0]!.adapter.failures.push(new DeliveryPermanentSchemaError('destination_schema_rejected'));
  await fixtures[0]!.service.run(fixtures[0]!.deliveryId, fixtures[0]!.execution);
  await fixtures[1]!.service.run(fixtures[1]!.deliveryId, fixtures[1]!.execution);
  await fixtures[2]!.repository.recordPackageVersion(packageVersionInput(fixtures[2]!.runId, 'replacement'));

  for (const fixture of fixtures) {
    const requestCount = fixture.adapter.requests.length;
    await assert.rejects(
      fixture.service.run(fixture.deliveryId, fixture.execution),
      /cannot be run from state/i,
    );
    assert.equal(fixture.adapter.requests.length, requestCount);
  }
});

class RecordingAdapter implements DeliveryAdapter {
  readonly requests: DeliveryAdapterInput[] = [];
  readonly failures: Error[] = [];
  nextStatus: DeliveryAdapterResponse['status'] = 'imported';
  verifyMatches = true;
  verifyFailure?: Error;
  onVerify?: () => Promise<void>;
  deliverBarrier?: Promise<void>;
  verifyRequests = 0;
  private deliverStartedResolve!: () => void;
  readonly deliverStarted = new Promise<void>((resolve) => { this.deliverStartedResolve = resolve; });

  async deliver(input: DeliveryAdapterInput): Promise<DeliveryAdapterResponse> {
    this.requests.push(structuredClone(input));
    this.deliverStartedResolve();
    await this.deliverBarrier;
    const failure = this.failures.shift();
    if (failure) throw failure;
    const variant = String(input.knowledgeBits.content.target.payload.title).split(' ').at(-1);
    return {
      externalId: `external-${variant}`,
      previewUrl: `https://delivery.example.test/${variant}`,
      status: this.nextStatus,
    };
  }

  async verify() {
    this.verifyRequests += 1;
    await this.onVerify?.();
    if (this.verifyFailure) throw this.verifyFailure;
    return { matches: this.verifyMatches, url: 'https://delivery.example.test/verified' };
  }
}

async function approvedFixture(variant: string) {
  let now = new Date('2026-07-13T10:00:00.000Z');
  const clock = () => now;
  const repository = new WorkflowRepository(createInMemoryWorkflowStore({ clock }));
  const runId = randomUUID();
  await repository.createRun({
    id: runId,
    title: `Delivery ${variant}`,
    locale: 'en',
    brief: {},
    currentStage: 'human_review',
    stages: [{ name: 'human_review', state: 'needs_human' }],
  });
  const packageVersion = await repository.recordPackageVersion(packageVersionInput(runId, variant));
  await repository.reviewRun({
    runId,
    packageChecksum: packageVersion.packageChecksum,
    decision: 'approve',
    reviewerId: 'editor-1',
  });
  const delivery = await repository.getDeliveryForPackage(runId, packageVersion.packageChecksum);
  assert.ok(delivery);
  const adapter = new RecordingAdapter();
  const claim = async () => {
    const claimed = await repository.claimJob({
      workerId: 'delivery-worker',
      capabilities: ['deliver_package'],
      leaseSeconds: 60,
    });
    assert.ok(claimed);
    return { jobId: claimed.jobId, workerId: 'delivery-worker' };
  };
  const execution = await claim();
  return {
    adapter,
    deliveryId: delivery.id,
    packageVersion,
    repository,
    runId,
    execution,
    claim,
    advanceClock: (milliseconds: number) => { now = new Date(now.getTime() + milliseconds); },
    finishAttempt: async (result: Awaited<ReturnType<DeliveryService['run']>>) => {
      const retryAt = 'retryAt' in result ? result.retryAt : undefined;
      await repository.applyJobResult({
        workerId: execution.workerId,
        result: {
          jobId: execution.jobId,
          packageId: runId,
          stage: 'deliver',
          state: result.state === 'succeeded' ? 'done' : result.state === 'needs_human' ? 'needs_human' : 'waiting',
          completedAt: clock().toISOString(),
          outputChecksum: result.state === 'succeeded' ? result.packageChecksum : null,
          error: result.state === 'succeeded' ? null : result.error,
        },
        transition: result.state === 'succeeded'
          ? { stage: 'deliver', state: 'done', revisionAttempts: 0, packageChecksum: packageVersion.packageChecksum, approvedChecksum: packageVersion.packageChecksum, effects: [{ type: 'record_delivery', state: 'succeeded' }] }
          : { stage: 'deliver', state: result.state === 'needs_human' ? 'needs_human' : 'waiting', revisionAttempts: 0, packageChecksum: packageVersion.packageChecksum, approvedChecksum: packageVersion.packageChecksum, reason: result.error, effects: [] },
        ...(retryAt ? { retryAt } : {}),
      });
    },
    service: new DeliveryService({ repository, adapter, clock }),
  };
}

function packageVersionInput(runId: string, variant: string): RecordPackageVersionInput {
  const sourceId = randomUUID();
  const material = {
    adapterVersion: 'knowledge-bits.review-package.v1',
    locale: 'en',
    owner: 'knowledge-bits-engine',
    usageRights: { scope: 'internal-review' },
    content: {
      schemaVersion: 'knowledge-bits.content.v1' as const,
      target: { kind: 'nuglet.lesson.v1' as const, payload: { title: `Package ${variant}` } },
    },
    evidence: {
      schemaVersion: 'knowledge-bits.evidence.v1' as const,
      sources: [{
        sourceId,
        url: 'https://example.test/source',
        title: 'Source',
        retrievedAt: '2026-07-13T09:00:00.000Z',
        checksum: '1'.repeat(64),
      }],
      claims: [{ claimId: randomUUID(), statement: 'A grounded claim.', citations: [{ sourceId, excerpt: 'Evidence.' }] }],
    },
    qa: {
      deterministic: { passed: true, findings: [] },
      editorial: { summary: 'Ready', findings: [] },
    },
    artifactInventory: [],
  };
  return {
    runId,
    revision: 1,
    packageChecksum: calculatePackageChecksum({ ...material, assetInventory: material.artifactInventory }),
    ...material,
  };
}
