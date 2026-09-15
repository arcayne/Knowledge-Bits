import assert from 'node:assert/strict';
import test from 'node:test';

import { createEngineAuthConfig } from './auth.js';

test('rejects duplicate tokens across API, review, and worker scopes', () => {
  assert.throws(() => createEngineAuthConfig({
    ENGINE_API_TOKEN: 'shared-token',
    ENGINE_REVIEW_TOKEN: 'review-token',
    ENGINE_WORKER_CREDENTIALS: JSON.stringify([{
      token: 'shared-token',
      workerId: 'research-worker',
      capabilities: ['collect_sources'],
    }]),
  }), /distinct tokens/i);
});

test('rejects duplicate worker credentials at startup', () => {
  assert.throws(() => createEngineAuthConfig({
    ENGINE_WORKER_CREDENTIALS: JSON.stringify([
      { token: 'worker-a', workerId: 'research-worker', capabilities: ['collect_sources'] },
      { token: 'worker-b', workerId: 'research-worker', capabilities: ['create_content'] },
    ]),
  }), /duplicate worker/i);
});
