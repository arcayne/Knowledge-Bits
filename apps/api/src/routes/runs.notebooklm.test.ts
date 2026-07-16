import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp } from '../app.js';
import { createInMemoryWorkflowStore, WorkflowRepository } from '../repositories/workflow-repository.js';

function createTestApp() {
  return createApp({
    repository: new WorkflowRepository(createInMemoryWorkflowStore()),
    env: { ENGINE_API_TOKEN: 'engine-api-test', ENGINE_REVIEW_TOKEN: 'engine-review-test' },
  });
}

test('stores the run-scoped NotebookLM ID and rejects accidental reuse', async () => {
  const app = createTestApp();
  const headers = {
    Authorization: 'Bearer engine-api-test',
    'Content-Type': 'application/json',
  };
  const first = await app.request('/runs', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'First run',
      locale: 'en',
      notebookLmNotebookId: 'notebook-1',
      brief: { objective: 'First' },
    }),
  });
  assert.equal(first.status, 201, await first.clone().text());
  assert.equal((await first.json()).notebookLmNotebookId, 'notebook-1');

  const duplicate = await app.request('/runs', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'Duplicate run',
      locale: 'en',
      notebookLmNotebookId: 'notebook-1',
      brief: { objective: 'Duplicate' },
    }),
  });
  assert.equal(duplicate.status, 409, await duplicate.clone().text());
  assert.match(await duplicate.text(), /already assigned/);
});

test('accepts a legacy brief-embedded NotebookLM ID and exposes it explicitly', async () => {
  const app = createTestApp();
  const response = await app.request('/runs', {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-api-test' },
    body: JSON.stringify({
      title: 'Legacy run',
      locale: 'en',
      brief: { objective: 'Legacy', notebookLmNotebookId: 'notebook-legacy' },
    }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal((await response.json()).notebookLmNotebookId, 'notebook-legacy');
});

test('rejects Nuglet run and notebook identity drift at run intake', async () => {
  const app = createTestApp();
  const headers = {
    Authorization: 'Bearer engine-api-test',
    'Content-Type': 'application/json',
  };
  const validBrief = nugletBrief();

  const cases: Array<{
    name: string;
    mutate: (request: NugletRunRequest) => void;
  }> = [
    { name: 'descriptor run ID', mutate: (request) => { request.brief.baseline.runId = 'another-run'; } },
    { name: 'descriptor notebook ID', mutate: (request) => { request.brief.notebookLmNotebookId = 'another-notebook'; } },
    { name: 'request notebook ID', mutate: (request) => { request.notebookLmNotebookId = 'another-notebook'; } },
  ];
  for (const { name, mutate } of cases) {
    const request: NugletRunRequest = {
      title: `Invalid ${name}`,
      locale: 'en',
      brief: structuredClone(validBrief),
      notebookLmNotebookId: 'notebook-fixture',
    };
    mutate(request);
    const response = await app.request('/runs', {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });
    assert.equal(response.status, 400, `${name}: ${await response.clone().text()}`);
    assert.deepEqual(await response.json(), { error: 'Invalid run input' });
  }
});

type NugletRunRequest = {
  title: string;
  locale: string;
  brief: ReturnType<typeof nugletBrief>;
  notebookLmNotebookId: string;
};

function nugletBrief() {
  const checksum = 'a'.repeat(64);
  const recipes = {
    story: 'nuglet.lesson.story',
    playbook: 'nuglet.lesson.playbook',
    challenge: 'nuglet.challenge',
    infographic: 'nuglet.visual.infographic',
    audioBrief: 'nuglet.audio.brief',
    audioDiscussion: 'nuglet.audio.discussion',
    hero: 'nuglet.hero',
    editorialQa: 'nuglet.qa.editorial',
  };
  const recipeBindings = Object.fromEntries(Object.entries(recipes).map(([role, id]) => [role, {
    id,
    version: '1.0.0',
    checksum: `sha256:${checksum}`,
  }]));
  const artifact = (role: string, artifactId: string, path: string) => ({
    checksum: `sha256:${(role === 'audioBrief' ? 'b' : role === 'audioDiscussion' ? 'c' : 'd').repeat(64)}`,
    generation: {
      artifactId,
      model: 'notebooklm-cli:fixture',
      notebookId: 'notebook-fixture',
      prompt: { bytesBase64: Buffer.from(`Generate ${artifactId}`).toString('base64'), checksum: `sha256:${checksum}` },
      provider: 'notebooklm',
      recipe: recipeBindings[role],
    },
    mediaType: role.startsWith('audio') ? 'audio/mp4' : 'image/webp',
    path,
    providerArtifactId: artifactId,
  });
  return {
    baseline: { runId: 'fixture-run' },
    notebookLmNotebookId: 'notebook-fixture',
    generationPlan: {
      contentKind: 'nuglet.lesson.v1',
      schemaVersion: '1.1.0',
      recipes: recipeBindings,
      heroDirection: {
        concept: 'Moving from saving to growth',
        metaphor: 'A vessel connected to tokens and a seedling',
        compositionFamily: 'asymmetrical-story',
        mustInclude: ['one vessel'],
        mustAvoid: ['rigid symmetry'],
      },
      mediaBaseline: {
        descriptorChecksum: `sha256:${checksum}`,
        descriptorPath: 'knowledge-bits/media-baseline.v1.json',
        descriptor: {
          artifacts: {
            infographic: artifact('infographic', 'infographic-artifact', 'notebooklm/infographic.webp'),
            audioBrief: artifact('audioBrief', 'brief-artifact', 'audio/notebooklm-short-brief.m4a'),
            audioDiscussion: artifact('audioDiscussion', 'discussion-artifact', 'audio/notebooklm-medium-debate.m4a'),
          },
          notebookId: 'notebook-fixture',
          runFolder: 'apps/nuglet-lab/outputs/fixture-run',
          runId: 'fixture-run',
          schemaVersion: 'nuglet.media-baseline.v1',
        },
      },
    },
  };
}
