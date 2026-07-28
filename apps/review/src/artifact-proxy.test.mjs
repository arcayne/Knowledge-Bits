import assert from 'node:assert/strict';
import test from 'node:test';

import { forwardArtifactRequest } from './artifact-proxy.mjs';

const runId = '4be543a5-d3ce-4606-9981-ea698b08e2fd';
const artifactId = '1ea0124a-d8ea-4d98-a5d6-5b8f2ef0fa3f';

test('artifact proxy preserves the API base path and streams media bytes', async () => {
  let requestedUrl = '';
  let requestedHeaders;
  const response = await forwardArtifactRequest({
    apiUrl: 'https://engine.example.test/api',
    token: 'server-review-token',
    reviewerId: 'operator-123',
    runId,
    artifactId,
    fetch: async (url, init) => {
      requestedUrl = String(url);
      requestedHeaders = new Headers(init.headers);
      return new Response(Uint8Array.from([1, 2, 3]), {
        headers: { 'Content-Type': 'image/webp' },
      });
    },
  });

  assert.equal(
    requestedUrl,
    `https://engine.example.test/api/runs/${runId}/artifacts/${artifactId}`,
  );
  assert.equal(requestedHeaders.get('Authorization'), 'Bearer server-review-token');
  assert.equal(requestedHeaders.get('X-Knowledge-Bits-Reviewer'), 'operator-123');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'image/webp');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.from([1, 2, 3]));
});

test('artifact proxy fails closed without server configuration', async () => {
  const response = await forwardArtifactRequest({
    apiUrl: '',
    token: '',
    reviewerId: '',
    runId,
    artifactId,
    fetch: () => assert.fail('fetch must not run without server configuration'),
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'The review service is not configured' });
});
