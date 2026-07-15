import assert from 'node:assert/strict';
import test from 'node:test';

import { parseProductRecipeRoots } from './config.js';

test('parses product recipe roots as an absolute content-kind map', () => {
  assert.deepEqual(
    parseProductRecipeRoots('{"nuglet.lesson.v1":"/srv/recipes/nuglet.lesson.v1"}'),
    { 'nuglet.lesson.v1': '/srv/recipes/nuglet.lesson.v1' },
  );
});

test('rejects malformed, blank, and relative product recipe roots', () => {
  for (const value of [
    'not-json',
    '[]',
    '{}',
    '{"nuglet.lesson.v1":""}',
    '{"nuglet.lesson.v1":"relative/recipes"}',
  ]) {
    assert.throws(() => parseProductRecipeRoots(value), /product_recipe_roots_invalid/);
  }
});
