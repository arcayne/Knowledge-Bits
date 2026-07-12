import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = new URL('./pages/runs/[runId].astro', import.meta.url);
const proxy = new URL('./pages/api/review.ts', import.meta.url);

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
