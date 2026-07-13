import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = new URL('./pages/runs/[runId].astro', import.meta.url);
const proxy = new URL('./pages/api/review.ts', import.meta.url);
const readme = new URL('../../../README.md', import.meta.url);

test('review page has one fixed overall decision bar and the required review surfaces', async () => {
  const source = await readFile(page, 'utf8');

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
  assert.match(source, /decisionAllowed/);
  assert.match(source, /disabled/);
  assert.match(source, /previewPath/);
  assert.match(source, /citations/);
  assert.match(source, /findings/);
  assert.doesNotMatch(source, /provider controls/i);
  assert.doesNotMatch(source, /execution logs/i);
});

test('review proxy never forwards browser or UI configured reviewer identities', async () => {
  const source = await readFile(proxy, 'utf8');

  assert.doesNotMatch(source, /ENGINE_REVIEWER_ID/);
  assert.doesNotMatch(source, /reviewerId/);
});

test('review submits the checksum displayed by the review surface', async () => {
  const source = await readFile(page, 'utf8');

  assert.match(source, /#checksum['"]\)\.textContent\s*=\s*payload\.currentPackageChecksum/);
  assert.match(source, /packageChecksum:\s*model\.currentPackageChecksum/);
  assert.doesNotMatch(source, /packageChecksum:\s*model\.package\.packageChecksum/);
});

test('documented review API environment matches the server proxy', async () => {
  const [documentation, proxySource] = await Promise.all([
    readFile(readme, 'utf8'),
    readFile(proxy, 'utf8'),
  ]);
  const reviewCommand = documentation.match(/Start the review app on port 4321:\n\n```bash\n([\s\S]*?)```/)?.[1];

  assert.ok(reviewCommand, 'README should contain the review startup command');
  assert.match(reviewCommand, /ENGINE_API_URL="http:\/\/127\.0\.0\.1:3000"/);
  assert.doesNotMatch(reviewCommand, /ENGINE_API_BASE_URL/);
  assert.match(proxySource, /import\.meta\.env\.ENGINE_API_URL/);
});
