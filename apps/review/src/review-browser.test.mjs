import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { chromium } from 'playwright';

const checksum = 'a'.repeat(64);

test('browser renders the complete approved payload and submits its displayed checksum', { timeout: 30_000 }, async (t) => {
  let decision;
  let csrf;
  const clientSource = await readFile(new URL('./review-client.mjs', import.meta.url), 'utf8');
  const server = createServer(async (request, response) => {
    if (request.url === '/review-client.mjs') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(clientSource);
      return;
    }
    if (request.url?.startsWith('/api/review') && request.method === 'GET') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(reviewModel()));
      return;
    }
    if (request.url === '/api/review' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      decision = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      csrf = request.headers['x-csrf-token'];
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ reviewStatus: 'approved' }));
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end(browserFixtureHtml());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Browser test server did not bind');
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.waitForSelector('#review:not([hidden])');

  for (const [path, expected] of Object.entries(contentValues())) {
    assert.equal(await page.locator(`[data-content-path="${path}"]`).textContent(), expected);
  }
  assert.match(await page.locator('#claims').textContent() ?? '', /restart decisions/i);
  assert.equal(await page.locator('#checksum').textContent(), checksum);
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.waitForTimeout(100);

  assert.ok(decision);
  assert.equal(decision.packageChecksum, checksum);
  assert.equal(decision.decision, 'approve');
  assert.equal(csrf, 'browser-csrf-token');
});

function reviewModel() {
  const claimId = '11111111-1111-4111-8111-111111111111';
  const sourceId = '22222222-2222-4222-8222-222222222222';
  const snapshotArtifactId = '33333333-3333-4333-8333-333333333333';
  const payload = {
    ...contentValues(),
    depths: {
      quick: contentValues()['depths.quick'],
      core: contentValues()['depths.core'],
      deep: contentValues()['depths.deep'],
    },
    claims: [{
      claimId,
      statement: 'A concrete next action reduces restart decisions.',
      citations: [{ sourceId, snapshotArtifactId, excerpt: 'A next action removes a restart decision.' }],
    }],
    claimCoverage: [
      'title', 'takeaway', 'action', 'depths.quick', 'depths.core', 'depths.deep',
    ].map((path) => ({ path, claimIds: [claimId] })),
  };
  delete payload['depths.quick'];
  delete payload['depths.core'];
  delete payload['depths.deep'];
  const snapshot = {
    artifactId: snapshotArtifactId, kind: 'source_snapshot', mediaType: 'text/plain', checksum,
    storageKey: 'sources/accepted', byteSize: 120, createdAt: '2026-07-13T10:00:00.000Z', provider: 'fixture', inputChecksum: null,
  };
  return {
    runId: '44444444-4444-4444-8444-444444444444',
    title: 'Return to one task', currentStage: 'human_review', currentRevision: 1, reviewStatus: 'pending',
    currentPackageChecksum: checksum, decisionAllowed: true, issues: [],
    package: {
      packageChecksum: checksum,
      content: { target: { payload } },
      evidence: {
        acceptedSources: [{ sourceId, title: 'Accepted source', url: 'https://example.test', snapshot }],
        rejectedSources: [], coverageGaps: [], claims: payload.claims,
      },
      qa: { deterministic: { passed: true, findings: [] }, editorial: { summary: 'Ready.', findings: [] } },
    },
    assets: {
      hero: { state: 'missing' }, infographic: { state: 'missing' }, audio: { state: 'missing' },
    },
  };
}

function contentValues() {
  return {
    title: 'Return to one task',
    takeaway: 'Make the return small and specific.',
    action: 'Write one next action.',
    'depths.quick': 'Name one action.',
    'depths.core': 'Remove one restart decision.',
    'depths.deep': 'A small defined action creates a practical boundary for returning to work.',
  };
}

function browserFixtureHtml() {
  return `<!doctype html><html><head><meta name="review-csrf-token" content="browser-csrf-token"></head><body>
    <main data-run-id="44444444-4444-4444-8444-444444444444"><h1 id="title"></h1><p id="status"></p><p id="checksum"></p><p id="error" hidden></p>
      <div id="review" hidden>${Object.keys(contentValues()).map((path) => `<p data-content-path="${path}"></p>`).join('')}
        <ul id="claim-coverage"></ul><ul id="accepted-sources"></ul><ul id="rejected-sources"></ul><ul id="coverage-gaps"></ul><ul id="claims"></ul>
        <p id="qa"></p><ul id="qa-findings"></ul><div id="hero"></div><div id="infographic"></div><div id="audio"></div></div></main>
    <span id="decision-status"></span><button data-decision="approve" disabled>Approve</button><button data-decision="request_changes" disabled>Request changes</button>
    <form id="change-form"><textarea id="comment" name="comment"></textarea><button disabled>Send changes</button></form>
    <script type="module">import { mountReviewPage } from '/review-client.mjs'; mountReviewPage();</script>
  </body></html>`;
}
