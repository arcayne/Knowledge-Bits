import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = new URL('./pages/runs/[runId].astro', import.meta.url);
const proxy = new URL('./pages/api/review.ts', import.meta.url);
const client = new URL('./review-client.mjs', import.meta.url);
const middleware = new URL('./middleware.ts', import.meta.url);
const readme = new URL('../../../README.md', import.meta.url);

test('review page has one fixed overall decision bar and the required review surfaces', async () => {
  const [source, clientSource] = await Promise.all([readFile(page, 'utf8'), readFile(client, 'utf8')]);

  for (const label of [
    'Learner preview',
    'Evidence',
    'QA',
    'Hero',
    'Infographic',
    'Audio',
    'Approve',
    'Request changes',
  ]) {
    assert.match(source, new RegExp(label));
  }
  assert.match(source, /position:\s*fixed/);
  assert.match(source, /name="comment"/);
  assert.match(clientSource, /decisionAllowed/);
  assert.match(source, /disabled/);
  assert.match(clientSource, /claimCoverage/);
  assert.match(clientSource, /acceptedSources/);
  assert.match(clientSource, /rejectedSources/);
  assert.match(clientSource, /coverageGaps/);
  assert.match(clientSource, /citations/);
  assert.match(clientSource, /findings/);
  assert.doesNotMatch(source, /provider controls/i);
  assert.doesNotMatch(source, /execution logs/i);
});

test('review proxy derives reviewer identity from authenticated middleware, not browser input', async () => {
  const [source, middlewareSource] = await Promise.all([readFile(proxy, 'utf8'), readFile(middleware, 'utf8')]);

  assert.doesNotMatch(source, /ENGINE_REVIEWER_ID/);
  assert.doesNotMatch(source, /body\.reviewerId/);
  assert.match(middlewareSource, /authenticateOperator/);
  assert.match(source, /X-CSRF-Token|validateReviewMutation/);
});

test('review submits the checksum displayed by the review surface', async () => {
  const source = await readFile(client, 'utf8');

  assert.match(source, /payload\.package\.packageChecksum\s*===\s*payload\.currentPackageChecksum/);
  assert.match(source, /packageChecksum\s*=\s*model\?\.package\?\.packageChecksum/);
  assert.match(source, /'X-CSRF-Token':\s*csrfToken/);
});

test('documented review API environment matches the server proxy', async () => {
  const [documentation, proxySource] = await Promise.all([
    readFile(readme, 'utf8'),
    readFile(proxy, 'utf8'),
  ]);
  const reviewCommand = documentation.match(/```bash\n(ENGINE_API_URL="http:\/\/127\.0\.0\.1:3000"[\s\S]*?)```/)?.[1];

  assert.ok(reviewCommand, 'README should contain the review startup command');
  assert.match(reviewCommand, /ENGINE_API_URL="http:\/\/127\.0\.0\.1:3000"/);
  assert.match(reviewCommand, /REVIEW_AUTH_JWKS_URL=/);
  assert.match(reviewCommand, /REVIEW_AUTH_ISSUER=/);
  assert.match(reviewCommand, /REVIEW_AUTH_AUDIENCE=/);
  assert.match(reviewCommand, /REVIEW_PUBLIC_ORIGIN=/);
  assert.doesNotMatch(reviewCommand, /ENGINE_API_BASE_URL/);
  assert.match(proxySource, /runtimeEnvironment\(import\.meta\.env, 'ENGINE_API_URL'\)/);
});
