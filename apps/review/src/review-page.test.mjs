import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = new URL('./pages/runs/[runId].astro', import.meta.url);

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
  assert.doesNotMatch(source, /provider controls/i);
  assert.doesNotMatch(source, /execution logs/i);
});
