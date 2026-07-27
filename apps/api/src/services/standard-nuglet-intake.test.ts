import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { knowledgeBitsRunBriefSchema, nugletGenerationPlanSchema } from '@knowledge-bits/contracts';

import {
  bindStandardNugletIntakePlan,
  standardRecipeBindings,
} from './standard-nuglet-intake.js';

test('binds the approved Story and Playbook plan to the standard intake marker', () => {
  const brief = bindStandardNugletIntakePlan({
    title: 'Match the Message to the Customer',
    brief: {
      title: 'Match the Message to the Customer',
      objective: 'Choose a message that fits the customer awareness stage.',
      notebookLmNotebookId: 'notebook-standard-intake',
      intake: { requestedBy: 'review_operator', requestedFormat: 'story_playbook' },
    },
  });

  const parsedBrief = knowledgeBitsRunBriefSchema.parse(brief);
  const plan = nugletGenerationPlanSchema.parse(parsedBrief.generationPlan);
  assert.equal(parsedBrief.contentKind, 'nuglet.lesson.v1');
  assert.equal(plan.schemaVersion, '1.1.0');
  assert.equal(plan.mediaMode, 'generate');
  assert.equal(plan.recipes.infographic.version, '1.1.0');
  assert.match(plan.heroDirection.metaphor, /customer awareness stage/);
});

test('standard bindings match approved entries in the repository recipe manifest', async () => {
  const manifest = JSON.parse(await readFile(
    new URL('../../../../recipes/nuglet.lesson.v1/manifest.json', import.meta.url),
    'utf8',
  )) as {
    recipes: Array<{ id: string; version: string; status: string; checksum: string }>;
  };
  const approved = new Set(manifest.recipes
    .filter(({ status }) => status === 'approved')
    .map(({ id, version, checksum }) => `${id}@${version}:${checksum}`));

  for (const binding of Object.values(standardRecipeBindings())) {
    assert.equal(approved.has(`${binding.id}@${binding.version}:${binding.checksum}`), true);
  }
});

test('does not change legacy briefs or caller-supplied validated plans', () => {
  const legacy = { objective: 'Legacy input' };
  assert.equal(bindStandardNugletIntakePlan({ title: 'Legacy', brief: legacy }), legacy);

  const first = bindStandardNugletIntakePlan({
    title: 'Bound once',
    brief: {
      objective: 'Bind once',
      intake: { requestedFormat: 'story_playbook' },
    },
  });
  assert.equal(bindStandardNugletIntakePlan({ title: 'Bound once', brief: first }), first);
});
