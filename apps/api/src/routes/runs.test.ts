import assert from 'node:assert/strict';
import test from 'node:test';

import { workflowRunResponseSchema } from '@knowledge-bits/contracts';
import { nextTransition } from '@knowledge-bits/pipeline';

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
  assert.deepEqual(workflowRunResponseSchema.parse(body), body);
  assert.equal(body.currentStage, 'research');
  assert.equal(body.stages.research.state, 'queued');
  assert.equal(body.stages.human_review, undefined);
  for (const stage of Object.values(body.stages) as Array<{ name: string; state: string }>) {
    assert.doesNotThrow(() => nextTransition({
      stage: stage.name as 'research',
      state: stage.state as 'queued',
      revisionAttempts: 0,
      packageChecksum: null,
      approvedChecksum: null,
    }, { type: 'package_changed', packageChecksum: 'a'.repeat(64) }));
  }
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

test('allows an authenticated review operator to start a research run', async () => {
  const app = createTestApp();
  const response = await app.request('/runs', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer engine-review-test',
      'X-Knowledge-Bits-Reviewer': 'operator@example.test',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: 'A new Nuglet',
      locale: 'en',
      notebookLmNotebookId: 'notebook-new',
      brief: {
        title: 'A new Nuglet',
        topic: 'A new Nuglet',
        objective: 'Help someone take one useful action.',
        audience: 'general adult learners',
        locale: 'en',
        notebookLmNotebookId: 'notebook-new',
      },
    }),
  });

  assert.equal(response.status, 201);
  assert.equal((await response.json()).notebookLmNotebookId, 'notebook-new');
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

test('rejects malformed JSON and maps repository bootstrap conflicts', async () => {
  const store = createInMemoryWorkflowStore({ idGenerator: () => '0f8fad5b-d9cb-469f-a165-70867728950e' });
  const app = createApp({
    repository: new WorkflowRepository(store),
    env: { ENGINE_API_TOKEN: 'engine-api-test', ENGINE_REVIEW_TOKEN: 'engine-review-test' },
  });
  const malformed = await app.request('/runs', {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-api-test', 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(malformed.status, 400);

  const first = await app.request('/runs', {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-api-test' },
    body: JSON.stringify({ title: 'Attention recovery', locale: 'en', brief: validBrief }),
  });
  assert.equal(first.status, 201);
  const conflict = await app.request('/runs', {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-api-test' },
    body: JSON.stringify({ title: 'Attention recovery', locale: 'en', brief: validBrief }),
  });
  assert.equal(conflict.status, 409);
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
