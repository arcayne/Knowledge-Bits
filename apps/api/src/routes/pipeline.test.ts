import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { createApp } from '../app.js';
import { createInMemoryWorkflowStore, WorkflowRepository } from '../repositories/workflow-repository.js';

test('pipeline list requires review auth and returns current run summaries', async () => {
  const repository = new WorkflowRepository(createInMemoryWorkflowStore());
  const runId = randomUUID();
  await repository.createRun({
    id: runId,
    title: 'Pipeline dashboard test',
    locale: 'en',
    brief: {},
    currentStage: 'human_review',
    stages: [{ name: 'human_review', state: 'needs_human', reason: 'Needs review' }],
  });
  const app = createApp({
    repository,
    env: { ENGINE_REVIEW_TOKEN: 'review-token' },
  });

  assert.equal((await app.request('/pipeline')).status, 401);
  const response = await app.request('/pipeline', {
    headers: { Authorization: 'Bearer review-token' },
  });
  assert.equal(response.status, 200);
  const persisted = (await repository.getRun(runId))!;
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(await response.json(), {
    daily: {
      day: today,
      timezone: 'UTC',
      target: 5,
      started: 1,
      readyForReview: 1,
      approvedInFlight: 0,
      delivered: 0,
      remaining: 5,
    },
    counts: {
      research: 0,
      create: 0,
      check: 0,
      produce_assets: 0,
      human_review: 1,
      deliver: 0,
      delivering: 0,
      needsHuman: 1,
      active: 1,
      completed: 0,
      rejected: 0,
      duplicates: 0,
      blocked: 1,
      retrying: 0,
    },
    runs: [{
      id: runId,
      title: 'Pipeline dashboard test',
      locale: 'en',
      classification: 'active',
      duplicateOf: null,
      currentStage: 'human_review',
      currentState: 'needs_human',
      reason: 'Needs review',
      currentRevision: 1,
      currentAttempt: 0,
      nextRetryAt: null,
      reviewStatus: 'pending',
      delivery: null,
      createdAt: persisted.createdAt.toISOString(),
      updatedAt: persisted.updatedAt.toISOString(),
    }],
  });
});

test('pipeline dashboard keeps superseded runs visible without counting them as active', async () => {
  let now = new Date('2026-07-20T10:00:00.000Z');
  const repository = new WorkflowRepository(createInMemoryWorkflowStore({ clock: () => now }));
  const baseline = { baseline: { runId: 'legacy-personal-finance' } };
  const oldRunId = randomUUID();
  const currentRunId = randomUUID();

  await repository.createRun({
    id: oldRunId,
    title: 'Personal Finance 101',
    locale: 'en',
    brief: baseline,
    currentStage: 'human_review',
    stages: [{ name: 'human_review', state: 'needs_human', reason: null }],
  });
  now = new Date('2026-07-20T11:00:00.000Z');
  await repository.createRun({
    id: currentRunId,
    title: 'Personal Finance 101',
    locale: 'en',
    brief: baseline,
    currentStage: 'deliver',
    stages: [{ name: 'deliver', state: 'queued', reason: null }],
  });

  const app = createApp({
    repository,
    env: { ENGINE_REVIEW_TOKEN: 'review-token' },
  });
  const response = await app.request('/pipeline', {
    headers: { Authorization: 'Bearer review-token' },
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.counts, {
    research: 0,
    create: 0,
    check: 0,
    produce_assets: 0,
    human_review: 0,
    deliver: 1,
    delivering: 1,
    needsHuman: 0,
    active: 0,
    completed: 0,
    rejected: 0,
    duplicates: 1,
    blocked: 0,
    retrying: 0,
  });
  assert.deepEqual(payload.daily, {
    day: new Date().toISOString().slice(0, 10),
    timezone: 'UTC',
    target: 5,
    started: 0,
    readyForReview: 0,
    approvedInFlight: 0,
    delivered: 0,
    remaining: 5,
  });
  assert.deepEqual(payload.runs.map((run: { id: string; classification: string; duplicateOf: string | null }) => ({
    id: run.id,
    classification: run.classification,
    duplicateOf: run.duplicateOf,
  })), [
    { id: currentRunId, classification: 'deliver', duplicateOf: null },
    { id: oldRunId, classification: 'duplicate', duplicateOf: currentRunId },
  ]);
});

test('pipeline dashboard separates rejected runs from active work and blockers', async () => {
  const repository = new WorkflowRepository(createInMemoryWorkflowStore());
  const runId = randomUUID();
  await repository.createRun({
    id: runId,
    title: 'Rejected wrong topic',
    locale: 'en',
    brief: {},
    currentStage: 'human_review',
    reviewStatus: 'rejected',
    stages: [{ name: 'human_review', state: 'done', reason: 'Generated the wrong topic.' }],
  });
  const app = createApp({ repository, env: { ENGINE_REVIEW_TOKEN: 'review-token' } });

  const response = await app.request('/pipeline', { headers: { Authorization: 'Bearer review-token' } });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.counts.rejected, 1);
  assert.equal(payload.counts.active, 0);
  assert.equal(payload.counts.needsHuman, 0);
  assert.equal(payload.counts.blocked, 0);
  assert.equal(payload.runs[0].classification, 'rejected');
});

test('pipeline summaries expose delivery attempts and retry timing', async () => {
  const now = new Date();
  const repository = new WorkflowRepository(createInMemoryWorkflowStore({ clock: () => now }));
  const runId = randomUUID();
  const checksum = `sha256:${'a'.repeat(64)}`;
  await repository.createRun({
    id: runId,
    title: 'Delivery retry visibility',
    locale: 'en',
    brief: {},
    currentStage: 'deliver',
    packageChecksum: checksum,
    approvedChecksum: checksum,
    reviewStatus: 'approved',
    stages: [{ name: 'deliver', state: 'waiting', reason: 'Destination temporarily unavailable', attempt: 2 }],
  });
  await repository.recordDelivery({
    runId,
    packageVersionId: randomUUID(),
    target: 'nuglet',
    packageChecksum: checksum,
    idempotencyKey: `delivery:${runId}`,
    state: 'waiting',
    nextAttemptAt: new Date(now.getTime() + 60_000),
  });
  const app = createApp({ repository, env: { ENGINE_REVIEW_TOKEN: 'review-token' } });
  const response = await app.request('/pipeline', {
    headers: { Authorization: 'Bearer review-token' },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.counts.blocked, 1);
  assert.equal(payload.counts.retrying, 1);
  assert.equal(payload.daily.approvedInFlight, 1);
  assert.deepEqual(payload.runs[0].delivery, {
    state: 'waiting',
    attempts: 0,
    target: 'nuglet',
    nextAttemptAt: new Date(now.getTime() + 60_000).toISOString(),
    updatedAt: now.toISOString(),
  });
  assert.equal(payload.runs[0].currentAttempt, 2);
});
