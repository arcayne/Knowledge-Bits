import assert from 'node:assert/strict';
import test from 'node:test';

import { FixtureProvider } from '../../apps/worker/dist/providers/fixture.js';

import { createSchema11RunRequest } from './schema-1-1-fixture.mjs';

test('schema 1.1.0 fixture provider emits Story Playbook content and four provenance-bound media roles', async () => {
  const provider = new FixtureProvider();
  const request = createSchema11RunRequest();
  const create = await provider.execute(executionInput('create_content', request.brief, [
    {
      action: 'collect_sources',
      artifactId: '10000000-0000-4000-8000-000000000001',
      checksum: 'a'.repeat(64),
      kind: 'source_snapshot',
      sourceId: '11111111-1111-4111-8111-111111111111',
    },
  ]));

  assert.equal(create.kind, 'success');
  if (create.kind !== 'success') return;
  assert.equal(create.parsedOutput.kind, 'nuglet.lesson.v1');
  assert.equal(create.parsedOutput.schemaVersion, '1.1.0');
  assert.notDeepEqual(create.parsedOutput.payload.read.story, create.parsedOutput.payload.read.playbook);
  assert.equal(create.parsedOutput.payload.quiz.questions.length, 3);
  assert.equal(create.supportArtifacts.length, 6);

  const produce = await provider.execute(executionInput('produce_assets', request.brief, [
    {
      action: 'collect_sources',
      artifactId: '10000000-0000-4000-8000-000000000001',
      checksum: 'a'.repeat(64),
      kind: 'source_snapshot',
      sourceId: '11111111-1111-4111-8111-111111111111',
    },
    {
      action: 'create_content',
      artifactId: '10000000-0000-4000-8000-000000000002',
      checksum: 'b'.repeat(64),
      kind: 'parsed_output',
    },
  ]));

  assert.equal(produce.kind, 'success');
  if (produce.kind !== 'success') return;
  assert.deepEqual(produce.assets.map(({ kind }) => kind), [
    'hero',
    'infographic',
    'audio_brief',
    'audio_discussion',
  ]);
  assert.notDeepEqual(produce.assets[2].body, produce.assets[3].body);
  assert.equal(produce.supportArtifacts.length, 8);
  assert.ok(produce.supportArtifacts.every(({ provenance }) => (
    typeof provenance.outputKind === 'string'
      && /^sha256:[a-f0-9]{64}$/.test(provenance.outputChecksum)
  )));
});

function executionInput(action, brief, dependencies) {
  return {
    action,
    idempotencyKey: `fixture-${action}`,
    signal: AbortSignal.timeout(10_000),
    job: {
      input: { brief, dependencies },
      stage: action === 'create_content' ? 'create' : 'produce_assets',
    },
  };
}
