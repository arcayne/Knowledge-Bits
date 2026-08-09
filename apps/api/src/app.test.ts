import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp } from './app.js';
import {
  createInMemoryWorkflowStore,
  WorkflowRepository,
} from './repositories/workflow-repository.js';

test('local API exposes an unauthenticated health probe for supervised startup', async () => {
  const app = createApp({ repository: new WorkflowRepository(createInMemoryWorkflowStore()) });
  const response = await app.request('/health');

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});
