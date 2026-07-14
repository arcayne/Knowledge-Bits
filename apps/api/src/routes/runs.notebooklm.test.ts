import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp } from '../app.js';
import { createInMemoryWorkflowStore, WorkflowRepository } from '../repositories/workflow-repository.js';

function createTestApp() {
  return createApp({
    repository: new WorkflowRepository(createInMemoryWorkflowStore()),
    env: { ENGINE_API_TOKEN: 'engine-api-test', ENGINE_REVIEW_TOKEN: 'engine-review-test' },
  });
}

test('stores the run-scoped NotebookLM ID and rejects accidental reuse', async () => {
  const app = createTestApp();
  const headers = {
    Authorization: 'Bearer engine-api-test',
    'Content-Type': 'application/json',
  };
  const first = await app.request('/runs', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'First run',
      locale: 'en',
      notebookLmNotebookId: 'notebook-1',
      brief: { objective: 'First' },
    }),
  });
  assert.equal(first.status, 201, await first.clone().text());
  assert.equal((await first.json()).notebookLmNotebookId, 'notebook-1');

  const duplicate = await app.request('/runs', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'Duplicate run',
      locale: 'en',
      notebookLmNotebookId: 'notebook-1',
      brief: { objective: 'Duplicate' },
    }),
  });
  assert.equal(duplicate.status, 409, await duplicate.clone().text());
  assert.match(await duplicate.text(), /already assigned/);
});

test('accepts a legacy brief-embedded NotebookLM ID and exposes it explicitly', async () => {
  const app = createTestApp();
  const response = await app.request('/runs', {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-api-test' },
    body: JSON.stringify({
      title: 'Legacy run',
      locale: 'en',
      brief: { objective: 'Legacy', notebookLmNotebookId: 'notebook-legacy' },
    }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal((await response.json()).notebookLmNotebookId, 'notebook-legacy');
});
