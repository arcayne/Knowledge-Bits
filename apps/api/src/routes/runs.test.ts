import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp } from '../app.js';
import {
  createInMemoryWorkflowStore,
  WorkflowRepository,
} from '../repositories/workflow-repository.js';

const validBrief = {
  audience: 'People rebuilding focus after a distracted week',
  objective: 'Create one practical Nuglet lesson',
};

function createTestApp() {
  return createApp({
    repository: new WorkflowRepository(createInMemoryWorkflowStore()),
    env: {
      ENGINE_API_TOKEN: 'engine-api-test',
      ENGINE_WORKER_TOKEN: 'engine-worker-test',
      ENGINE_REVIEW_TOKEN: 'engine-review-test',
    },
  });
}

test('creates a run with all stages and research queued', async () => {
  const app = createTestApp();
  const response = await app.request('/runs', {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-api-test' },
    body: JSON.stringify({ title: 'Attention recovery', locale: 'en', brief: validBrief }),
  });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.currentStage, 'research');
  assert.equal(body.stages.research.state, 'queued');
  assert.deepEqual(Object.keys(body.stages), [
    'research', 'create', 'check', 'produce_assets', 'human_review', 'deliver',
  ]);
});

test('requires the engine API token to create and inspect runs', async () => {
  const app = createTestApp();
  const missingToken = await app.request('/runs', {
    method: 'POST',
    body: JSON.stringify({ title: 'Attention recovery', locale: 'en', brief: validBrief }),
  });
  assert.equal(missingToken.status, 401);

  const wrongScope = await app.request('/runs', {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-worker-test' },
    body: JSON.stringify({ title: 'Attention recovery', locale: 'en', brief: validBrief }),
  });
  assert.equal(wrongScope.status, 403);
});

test('rejects malformed run input', async () => {
  const app = createTestApp();
  const response = await app.request('/runs', {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-api-test' },
    body: JSON.stringify({ title: '', locale: 'en', brief: [] }),
  });

  assert.equal(response.status, 400);
});

test('retrieves the persisted run state', async () => {
  const app = createTestApp();
  const created = await app.request('/runs', {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-api-test' },
    body: JSON.stringify({ title: 'Attention recovery', locale: 'en', brief: validBrief }),
  });
  const run = await created.json();

  const response = await app.request(`/runs/${run.id}`, {
    headers: { Authorization: 'Bearer engine-api-test' },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, run.id);
});
