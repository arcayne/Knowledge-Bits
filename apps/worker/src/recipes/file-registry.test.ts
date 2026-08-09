import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  FileRecipeRegistry,
  RecipeRegistryError,
  renderPromptSections,
} from './file-registry.js';

test('resolves canonical recipe bytes only when the manifest checksum matches', () => {
  const recipe = {
    id: 'example.story',
    instructions: ['Open with the practical tension.', 'End with one action.'],
    status: 'approved',
    version: '1.0.0',
  };
  const root = recipeRoot('example.lesson', recipe);
  const registry = new FileRecipeRegistry({ 'example.lesson': root });

  const resolved = registry.resolve({
    contentKind: 'example.lesson',
    id: recipe.id,
    version: recipe.version,
    checksum: checksum(canonicalJsonBytes(recipe)),
  });

  assert.deepEqual(resolved.value, recipe);
  assert.equal(Buffer.from(resolved.canonicalBytes).toString('utf8'), Buffer.from(canonicalJsonBytes(recipe)).toString('utf8'));
  assert.equal(resolved.checksum, checksum(resolved.canonicalBytes));
  assert.equal(JSON.stringify(resolved).includes(root), false);
});

test('recalculates canonical bytes and rejects a same-version checksum mismatch', () => {
  const recipe = {
    id: 'example.story',
    instructions: ['Original instruction.'],
    status: 'approved',
    version: '1.0.0',
  };
  const root = recipeRoot('example.lesson', recipe);
  const registry = new FileRecipeRegistry({ 'example.lesson': root });

  writeFileSync(join(root, 'story.json'), JSON.stringify({
    ...recipe,
    instructions: ['Changed without a new version.'],
  }));

  assert.throws(
    () => registry.resolve({
      contentKind: 'example.lesson',
      id: recipe.id,
      version: recipe.version,
      checksum: checksum(canonicalJsonBytes(recipe)),
    }),
    (error: unknown) => error instanceof RecipeRegistryError && error.code === 'recipe_checksum_mismatch',
  );
});

test('renders prompt sections with LF endings and trailing whitespace removed without changing leading content', () => {
  const rendered = renderPromptSections([
    '  FIRST SECTION  \r\n    line one\t\r\n',
    'SECOND SECTION\r\n\tline two   ',
    'THIRD SECTION',
  ]);

  assert.equal(
    Buffer.from(rendered).toString('utf8'),
    '  FIRST SECTION\n    line one\n\nSECOND SECTION\n\tline two\n\nTHIRD SECTION',
  );
});

test('verifies every recipe binding in a Nuglet generation plan against trusted files', () => {
  const recipes = [
    ['story', 'nuglet.lesson.story'],
    ['playbook', 'nuglet.lesson.playbook'],
    ['challenge', 'nuglet.challenge'],
    ['infographic', 'nuglet.visual.infographic'],
    ['audioBrief', 'nuglet.audio.brief'],
    ['audioDiscussion', 'nuglet.audio.discussion'],
    ['hero', 'nuglet.hero'],
    ['editorialQa', 'nuglet.qa.editorial'],
  ] as const;
  const root = mkdtempSync(join(tmpdir(), 'knowledge-bits-recipes-'));
  const manifestEntries = recipes.map(([, id]) => {
    const value = { id, instructions: [`Instructions for ${id}.`], status: 'approved', version: '1.0.0' };
    const path = `${id}/1.0.0.json`;
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(value, null, 2));
    return { id, version: '1.0.0', status: 'approved', path, checksum: checksum(canonicalJsonBytes(value)) };
  });
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({
    contentKind: 'nuglet.lesson.v1',
    registryVersion: '1.0.0',
    recipes: manifestEntries,
  }, null, 2));
  const registry = new FileRecipeRegistry({ 'nuglet.lesson.v1': root });
  const plan = {
    contentKind: 'nuglet.lesson.v1' as const,
    schemaVersion: '1.1.0' as const,
    recipes: Object.fromEntries(recipes.map(([key, id]) => {
      const entry = manifestEntries.find((candidate) => candidate.id === id)!;
      return [key, { id, version: entry.version, checksum: entry.checksum }];
    })),
    heroDirection: {
      concept: 'A useful idea becomes concrete',
      metaphor: 'One object moving toward a clear path',
      compositionFamily: 'asymmetrical-story' as const,
      mustInclude: ['one focal object'],
      mustAvoid: ['rigid symmetry'],
    },
  };

  assert.equal(registry.verify(plan as Parameters<FileRecipeRegistry['verify']>[0]), true);
  plan.recipes.hero!.checksum = `sha256:${'f'.repeat(64)}`;
  assert.equal(registry.verify(plan as Parameters<FileRecipeRegistry['verify']>[0]), false);
});

test('allows a deferred plan to retain an unresolvable hero binding without weakening other recipes', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-bits-recipes-'));
  const story = { id: 'nuglet.lesson.story', instructions: ['Keep the lesson concrete.'], status: 'approved', version: '1.0.0' };
  mkdirSync(join(root, 'story'), { recursive: true });
  writeFileSync(join(root, 'story/1.0.0.json'), JSON.stringify(story, null, 2));
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({
    contentKind: 'nuglet.lesson.v1',
    registryVersion: '1.0.0',
    recipes: [{
      id: story.id,
      version: story.version,
      status: story.status,
      path: 'story/1.0.0.json',
      checksum: checksum(canonicalJsonBytes(story)),
    }],
  }, null, 2));
  const registry = new FileRecipeRegistry({ 'nuglet.lesson.v1': root });
  const plan = {
    contentKind: 'nuglet.lesson.v1' as const,
    schemaVersion: '1.1.0' as const,
    heroMode: 'deferred' as const,
    recipes: {
      story: { id: story.id, version: story.version, checksum: checksum(canonicalJsonBytes(story)) },
      hero: { id: 'nuglet.hero', version: '9.9.9', checksum: `sha256:${'f'.repeat(64)}` },
    },
    heroDirection: {
      concept: 'A useful idea becomes concrete',
      metaphor: 'One object moving toward a clear path',
      compositionFamily: 'asymmetrical-story' as const,
      mustInclude: ['one focal object'],
      mustAvoid: ['rigid symmetry'],
    },
  };

  const resolved = registry.resolvePlan(plan as Parameters<FileRecipeRegistry['resolvePlan']>[0]);
  assert.deepEqual(resolved.hero?.value, {});
  assert.equal(resolved.story?.id, story.id);
});

test('rejects manifest paths that escape the configured recipe root', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-bits-recipes-'));
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({
    contentKind: 'example.lesson',
    registryVersion: '1.0.0',
    recipes: [{
      id: 'example.story',
      version: '1.0.0',
      status: 'approved',
      path: '../outside.json',
      checksum: `sha256:${'a'.repeat(64)}`,
    }],
  }));
  const registry = new FileRecipeRegistry({ 'example.lesson': root });

  assert.throws(
    () => registry.resolve({
      contentKind: 'example.lesson',
      id: 'example.story',
      version: '1.0.0',
      checksum: `sha256:${'a'.repeat(64)}`,
    }),
    (error: unknown) => error instanceof RecipeRegistryError && error.code === 'recipe_path_invalid',
  );
});

function recipeRoot(contentKind: string, recipe: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-bits-recipes-'));
  const recipeBytes = canonicalJsonBytes(recipe);
  writeFileSync(join(root, 'story.json'), JSON.stringify(recipe, null, 2));
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({
    contentKind,
    registryVersion: '1.0.0',
    recipes: [{
      id: recipe.id,
      version: recipe.version,
      status: recipe.status,
      path: 'story.json',
      checksum: checksum(recipeBytes),
    }],
  }, null, 2));
  return root;
}

function canonicalJsonBytes(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(sortJson(value), null, 2)}\n`);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
      .map((key) => [key, sortJson((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function checksum(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
