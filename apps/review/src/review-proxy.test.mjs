import assert from 'node:assert/strict';
import test from 'node:test';

import { forwardReviewRequest } from './review-proxy.mjs';

test('review proxy returns and submits the exact surface checksum with server authorization', async () => {
  const checksum = 'a'.repeat(64);
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (init.method === 'POST') {
      assert.deepEqual(JSON.parse(init.body), { decision: 'approve', packageChecksum: checksum });
      return Response.json({ reviewStatus: 'approved', approvedChecksum: checksum });
    }
    return Response.json({ currentPackageChecksum: checksum, package: { packageChecksum: checksum } });
  };

  const loaded = await forwardReviewRequest({
    apiUrl: 'https://engine.example.test',
    token: 'server-review-token',
    reviewerId: 'operator-123',
    path: '/runs/run-1/review',
    fetch,
  });
  const surface = await loaded.json();
  assert.equal(surface.currentPackageChecksum, checksum);

  const approved = await forwardReviewRequest({
    apiUrl: 'https://engine.example.test',
    token: 'server-review-token',
    reviewerId: 'operator-123',
    path: '/runs/run-1/review',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Knowledge-Bits-Reviewer': 'browser-spoof' },
      body: JSON.stringify({ decision: 'approve', packageChecksum: surface.currentPackageChecksum }),
    },
    fetch,
  });

  assert.equal(approved.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ url }) => url === 'https://engine.example.test/runs/run-1/review'));
  assert.ok(calls.every(({ init }) => new Headers(init.headers).get('Authorization') === 'Bearer server-review-token'));
  assert.ok(calls.every(({ init }) => new Headers(init.headers).get('X-Knowledge-Bits-Reviewer') === 'operator-123'));
});

test('review proxy preserves an API base path when forwarding requests', async () => {
  let requestedUrl = '';
  const response = await forwardReviewRequest({
    apiUrl: 'https://engine.example.test/api',
    token: 'server-review-token',
    reviewerId: 'operator-123',
    path: '/runs/similarity',
    fetch: async (url) => {
      requestedUrl = String(url);
      return Response.json({ risk: 'none', matches: [] });
    },
  });

  assert.equal(response.status, 200);
  assert.equal(requestedUrl, 'https://engine.example.test/api/runs/similarity');
});

test('review proxy fails closed when its server configuration is missing', async () => {
  const response = await forwardReviewRequest({
    apiUrl: '',
    token: '',
    reviewerId: '',
    path: '/runs/run-1/review',
    fetch: () => assert.fail('fetch must not run without server configuration'),
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'The review service is not configured' });
});
