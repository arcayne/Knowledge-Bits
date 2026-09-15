import assert from 'node:assert/strict';
import test from 'node:test';

import { workflowRunResponseSchema } from '@knowledge-bits/contracts';
import { nextTransition } from '@knowledge-bits/pipeline';

import { createApp } from '../app.js';
import {
  createInMemoryWorkflowStore,
  WorkflowRepository,
} from '../repositories/workflow-repository.js';

const validBrief = {
  audience: 'People rebuilding focus after a distracted week',
  objective: 'Create one practical Nuglet lesson',
};

function createTestApp() {
  return createApp({
    repository: new WorkflowRepository(createInMemoryWorkflowStore()),
    env: {
      ENGINE_API_TOKEN: 'engine-api-test',
      ENGINE_REVIEW_TOKEN: 'engine-review-test',
    },
  });
}

test('creates a run with all stages and research queued', async () => {
  const app = createTestApp();
  const response = await app.request('/runs', {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-api-test' },
    body: JSON.stringify({ title: 'Attention recovery', locale: 'en', brief: validBrief }),
  });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.deepEqual(workflowRunResponseSchema.parse(body), body);
  assert.equal(body.currentStage, 'research');
  assert.equal(body.stages.research.state, 'queued');
  assert.equal(body.stages.human_review, undefined);
  for (const stage of Object.values(body.stages) as Array<{ name: string; state: string }>) {
    assert.doesNotThrow(() => nextTransition({
      stage: stage.name as 'research',
      state: stage.state as 'queued',
      revisionAttempts: 0,
      packageChecksum: null,
      approvedChecksum: null,
    }, { type: 'package_changed', packageChecksum: 'a'.repeat(64) }));
  }
});

test('creates a Joan run from only a YouTube URL', async () => {
  const app = createTestApp();
  const response = await app.request('/runs/joan', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer engine-api-test',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ?t=42' }),
  });

  assert.equal(response.status, 201, await response.clone().text());
  const body = await response.json();
  assert.equal(body.brief.contentKind, 'joan.ai-video-brief.v1');
  assert.equal(body.brief.youtubeVideoId, 'dQw4w9WgXcQ');
  assert.equal(body.brief.youtubeUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.deepEqual(body.brief.sourceUrls, ['https://www.youtube.com/watch?v=dQw4w9WgXcQ']);
  assert.equal(body.currentStage, 'research');
  assert.equal(body.stages.research.state, 'queued');
  assert.equal(body.notebookLmNotebookId, null);
});

test('rejects duplicate Joan intake for the same canonical YouTube video', async () => {
  const app = createTestApp();
  const headers = {
    Authorization: 'Bearer engine-api-test',
    'Content-Type': 'application/json',
  };
  const first = await app.request('/runs/joan', {
    method: 'POST',
    headers,
    body: JSON.stringify({ youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }),
  });
  assert.equal(first.status, 201);
  const firstBody = await first.json();

  const duplicate = await app.request('/runs/joan', {
    method: 'POST',
    headers,
    body: JSON.stringify({ youtubeUrl: 'https://www.youtube.com/shorts/dQw4w9WgXcQ' }),
  });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), {
    error: 'A Joan run already exists for this YouTube video',
    runId: firstBody.id,
  });
});

test('rejects non-YouTube Joan intake', async () => {
  const app = createTestApp();
  const response = await app.request('/runs/joan', {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-api-test' },
    body: JSON.stringify({ youtubeUrl: 'https://example.com/video' }),
  });
  assert.equal(response.status, 400);
});

test('requires the engine API token to create and inspect runs', async () => {
  const app = createTestApp();
  const missingToken = await app.request('/runs', {
    method: 'POST',
    body: JSON.stringify({ title: 'Attention recovery', locale: 'en', brief: validBrief }),
  });
  assert.equal(missingToken.status, 401);

  const wrongScope = await app.request('/runs', {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-worker-test' },
    body: JSON.stringify({ title: 'Attention recovery', locale: 'en', brief: validBrief }),
  });
  assert.equal(wrongScope.status, 403);
});

test('allows an authenticated review operator to start a research run', async () => {
  const app = createTestApp();
  const response = await app.request('/runs', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer engine-review-test',
      'X-Knowledge-Bits-Reviewer': 'operator@example.test',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: 'A new Nuglet',
      locale: 'en',
      notebookLmNotebookId: 'notebook-new',
      brief: {
        title: 'A new Nuglet',
        topic: 'A new Nuglet',
        objective: 'Help someone take one useful action.',
        audience: 'general adult learners',
        locale: 'en',
        notebookLmNotebookId: 'notebook-new',
        intake: { requestedBy: 'review_operator', requestedFormat: 'story_playbook' },
      },
    }),
  });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.notebookLmNotebookId, 'notebook-new');
  assert.equal(body.brief.contentKind, 'nuglet.lesson.v1');
  assert.equal(body.brief.generationPlan.schemaVersion, '1.1.0');
  assert.equal(body.brief.generationPlan.mediaMode, 'generate');
  assert.equal(body.brief.intake.similarityReview.decision, 'clear');
});

test('checks every run for related content and requires an explicit distinct-angle decision', async () => {
  const app = createTestApp();
  const headers = {
    Authorization: 'Bearer engine-review-test',
    'X-Knowledge-Bits-Reviewer': 'operator@example.test',
    'Content-Type': 'application/json',
  };
  const existing = await app.request('/runs', {
    method: 'POST',
    headers,
    body: JSON.stringify(standardIntake({
      title: 'Why do smart people make bad decisions?',
      objective: 'Understand why intelligence does not prevent predictable decision errors.',
      notebookId: 'notebook-existing',
    })),
  });
  assert.equal(existing.status, 201, await existing.clone().text());

  const query = {
    title: "Why You're Predictably Irrational",
    objective: 'Recognize how framing, free offers, ownership, and expectations distort decisions.',
    audience: 'general adult learners',
    locale: 'en',
  };
  assert.equal((await app.request('/runs/similarity', {
    method: 'POST',
    body: JSON.stringify(query),
  })).status, 401);
  const checked = await app.request('/runs/similarity', {
    method: 'POST',
    headers,
    body: JSON.stringify(query),
  });
  assert.equal(checked.status, 200, await checked.clone().text());
  const similarity = await checked.json();
  assert.equal(similarity.risk, 'related');
  assert.equal(similarity.matches[0].title, 'Why do smart people make bad decisions?');

  const request = standardIntake({
    title: query.title,
    objective: query.objective,
    notebookId: 'notebook-new',
  });
  const blocked = await app.request('/runs', {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error, 'Similar Nuglets require explicit distinct-angle confirmation');

  const confirmedRequest = {
    ...request,
    brief: {
      ...request.brief,
      intake: {
        ...request.brief.intake,
        similarityReview: {
          fingerprint: similarity.fingerprint,
          decision: 'proceed_distinct',
        },
      },
    },
  };
  const created = await app.request('/runs', {
    method: 'POST',
    headers,
    body: JSON.stringify(confirmedRequest),
  });
  assert.equal(created.status, 201, await created.clone().text());
  assert.equal((await created.json()).brief.intake.similarityReview.decision, 'proceed_distinct');
});

test('rejects malformed run input', async () => {
  const app = createTestApp();
  const response = await app.request('/runs', {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-api-test' },
    body: JSON.stringify({ title: '', locale: 'en', brief: [] }),
  });

  assert.equal(response.status, 400);
});

test('rejects notebook identity drift after binding a standard intake plan', async () => {
  const app = createTestApp();
  const response = await app.request('/runs', {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-api-test', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Identity must stay stable',
      locale: 'en',
      notebookLmNotebookId: 'request-notebook',
      brief: {
        title: 'Identity must stay stable',
        objective: 'Keep one notebook bound to one run.',
        notebookLmNotebookId: 'brief-notebook',
        intake: { requestedBy: 'cli', requestedFormat: 'story_playbook' },
      },
    }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Invalid run input' });
});

test('rejects malformed JSON and maps repository bootstrap conflicts', async () => {
  const store = createInMemoryWorkflowStore({ idGenerator: () => '0f8fad5b-d9cb-469f-a165-70867728950e' });
  const app = createApp({
    repository: new WorkflowRepository(store),
    env: { ENGINE_API_TOKEN: 'engine-api-test', ENGINE_REVIEW_TOKEN: 'engine-review-test' },
  });
  const malformed = await app.request('/runs', {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-api-test', 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(malformed.status, 400);

  const first = await app.request('/runs', {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-api-test' },
    body: JSON.stringify({ title: 'Attention recovery', locale: 'en', brief: validBrief }),
  });
  assert.equal(first.status, 201);
  const conflict = await app.request('/runs', {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-api-test' },
    body: JSON.stringify({ title: 'Attention recovery', locale: 'en', brief: validBrief }),
  });
  assert.equal(conflict.status, 409);
});

test('retrieves the persisted run state', async () => {
  const app = createTestApp();
  const created = await app.request('/runs', {
    method: 'POST',
    headers: { Authorization: 'Bearer engine-api-test' },
    body: JSON.stringify({ title: 'Attention recovery', locale: 'en', brief: validBrief }),
  });
  const run = await created.json();

  const response = await app.request(`/runs/${run.id}`, {
    headers: { Authorization: 'Bearer engine-api-test' },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, run.id);
});

function standardIntake(input: { title: string; objective: string; notebookId: string }) {
  return {
    title: input.title,
    locale: 'en',
    notebookLmNotebookId: input.notebookId,
    brief: {
      title: input.title,
      topic: input.title,
      objective: input.objective,
      audience: 'general adult learners',
      locale: 'en',
      notebookLmNotebookId: input.notebookId,
      intake: { requestedBy: 'review_operator', requestedFormat: 'story_playbook' },
    },
  };
}
