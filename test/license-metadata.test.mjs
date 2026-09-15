import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packageFiles = [
  'package.json',
  'packages/contracts/package.json',
  'packages/evaluation/package.json',
  'packages/pipeline/package.json',
  'apps/api/package.json',
  'apps/review/package.json',
  'apps/worker/package.json',
];

test('repository ships the MIT license text', async () => {
  const license = await readFile(new URL('../LICENSE', import.meta.url), 'utf8');
  assert.match(license, /^MIT License/m);
  assert.match(license, /Copyright \(c\) 2026 arcayne/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
});

test('root and workspace manifests identify project-owned packages as MIT', async () => {
  for (const file of packageFiles) {
    const manifest = JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
    assert.equal(manifest.license, 'MIT', file);
  }
});
