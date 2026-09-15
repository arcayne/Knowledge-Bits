import test from 'node:test';
import assert from 'node:assert/strict';

import {
  approveRun,
  validateApprovedPackage,
  verifySeo,
  waitForDelivery,
} from './release-nuglet.mjs';

const checksum = 'a'.repeat(64);

function approvedFixture(overrides = {}) {
  const run = {
    id: 'run-1',
    currentStage: 'deliver',
    reviewStatus: 'approved',
    packageChecksum: checksum,
    approvedChecksum: checksum,
    ...overrides.run,
  };
  const review = {
    reviewStatus: 'approved',
    currentPackageChecksum: checksum,
    package: {
      id: 'package-version-1',
      packageId: 'run-1',
      packageChecksum: checksum,
      ...(overrides.package ?? {}),
    },
    ...overrides.review,
  };
  return { run, review };
}

test('validates that the approved checksum is consistent across run and package', () => {
  const { run, review } = approvedFixture();
  assert.equal(validateApprovedPackage({ run, review, expectedChecksum: checksum }).checksum, checksum);
});

test('rejects an approved checksum mismatch before release', () => {
  const { run, review } = approvedFixture();
  assert.throws(
    () => validateApprovedPackage({ run, review, expectedChecksum: 'b'.repeat(64) }),
    /does not match approved checksum|does not match package checksum/,
  );
});

test('approves only the exact pending package with separate API and review credentials', async () => {
  const { run, review } = approvedFixture({
    run: {
      currentStage: 'human_review',
      reviewStatus: 'pending',
      approvedChecksum: null,
    },
    review: {
      reviewStatus: 'pending',
      decisionAllowed: true,
    },
  });
  const approvedRun = { ...run, currentStage: 'deliver', reviewStatus: 'approved', approvedChecksum: checksum };
  const approvedReview = { ...review, reviewStatus: 'approved', decisionAllowed: false };
  const requests = [];
  const result = await approveRun({
    apiUrl: 'https://knowledge-bits.example.test',
    apiToken: 'api-token',
    token: 'review-token',
    reviewerId: 'operator@example.com',
    runId: 'run-1',
    packageChecksum: checksum,
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith('/review') && init.method === 'POST') return Response.json({});
      if (String(url).endsWith('/review')) return Response.json(requests.some((entry) => entry.init.method === 'POST') ? approvedReview : review);
      if (String(url).endsWith('/runs/run-1')) {
        return Response.json(requests.some((entry) => entry.init.method === 'POST') ? approvedRun : run);
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  assert.equal(result.alreadyApproved, false);
  const runRequests = requests.filter((entry) => entry.url.endsWith('/runs/run-1'));
  const reviewRequests = requests.filter((entry) => entry.url.endsWith('/review'));
  assert.equal(runRequests[0].init.headers.Authorization, 'Bearer api-token');
  assert.equal(reviewRequests[0].init.headers.Authorization, 'Bearer review-token');
  assert.equal(reviewRequests[1].init.headers['X-Knowledge-Bits-Reviewer'], 'operator@example.com');
});

test('waits for delivery and returns the succeeded pipeline state', async () => {
  let calls = 0;
  const result = await waitForDelivery({
    apiUrl: 'https://knowledge-bits.example.test',
    token: 'review-token',
    runId: 'run-1',
    intervalMs: 0,
    timeoutMs: 100,
    sleep: async () => {},
    fetchImpl: async () => new Response(JSON.stringify({
      runs: [{
        id: 'run-1',
        classification: calls++ === 0 ? 'deliver' : 'completed',
        delivery: { state: calls === 1 ? 'running' : 'succeeded' },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  });
  assert.equal(result.deliveryState, 'succeeded');
});

test('verifies the public SEO contract and reports llms.txt as a warning', async () => {
  const publicUrl = 'https://nuglet.app/lessons/fair-play';
  const responses = new Map([
    [publicUrl, `<!doctype html><html><head>
      <title>Fair Play</title>
      <meta name="description" content="A lesson about fair play">
      <meta name="robots" content="index,follow">
      <link rel="canonical" href="${publicUrl}">
      <meta property="og:title" content="Fair Play">
      <script type="application/ld+json">{"@type":"Article"}</script>
    </head></html>`],
    ['https://nuglet.app/robots.txt', 'Sitemap: https://nuglet.app/sitemap.xml\nSitemap: https://nuglet.app/knowledge-bits-sitemap.xml'],
    ['https://nuglet.app/knowledge-bits-sitemap.xml', `<?xml version="1.0"?><urlset><url><loc>${publicUrl}</loc><lastmod>2026-08-09</lastmod></url></urlset>`],
    ['https://nuglet.app/sitemap.xml', '<urlset></urlset>'],
    ['https://nuglet.app/llms.txt', '# Nuglet'],
  ]);
  const result = await verifySeo({
    url: publicUrl,
    fetchImpl: async (url) => new Response(responses.get(String(url)) ?? 'missing', {
      status: responses.has(String(url)) ? 200 : 404,
    }),
  });
  assert.equal(result.passed, true);
  assert.match(result.warnings[0], /llms\.txt/);
});
