import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { chromium } from 'playwright';

const fingerprint = 'a'.repeat(64);
const existingRunId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const createdRunId = '0f8fad5b-d9cb-469f-a165-70867728950f';

test('new Nuglet UI checks similarity, invalidates changed drafts, and submits a distinct-angle receipt', { timeout: 30_000 }, async (t) => {
  const clientSource = await readFile(new URL('./pipeline-client.mjs', import.meta.url), 'utf8');
  let createdRequest;
  let similarityCsrf;
  const server = createServer(async (request, response) => {
    if (request.url === '/pipeline-client.mjs') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(clientSource);
      return;
    }
    if (request.url === '/api/pipeline') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(emptyPipeline()));
      return;
    }
    if (request.url === '/api/similarity' && request.method === 'POST') {
      similarityCsrf = request.headers['x-csrf-token'];
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        method: 'deterministic_intake_v1',
        scope: 'all_knowledge_bits_runs',
        fingerprint,
        risk: 'related',
        matches: [{
          runId: existingRunId,
          title: 'Why do smart people make bad decisions?',
          objective: 'Understand predictable decision errors.',
          locale: 'en',
          currentStage: 'human_review',
          reviewStatus: 'pending',
          score: 0.55,
          reasons: ['shared concepts: decision_bias'],
          reviewPath: `/runs/${existingRunId}`,
        }],
      }));
      return;
    }
    if (request.url === '/api/runs' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      createdRequest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.statusCode = 201;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ id: createdRunId }));
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end(fixtureHtml());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Browser test server did not bind');
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}`);
  assert.match(await page.locator('#daily-progress').textContent() ?? '', /2026-07-27 · CEST · 5 remaining/);
  const start = page.getByRole('button', { name: 'Start research' });
  assert.equal(await start.isDisabled(), true);

  await page.locator('[name="title"]').fill("Why You're Predictably Irrational");
  await page.locator('[name="objective"]').fill('Recognize how framing and ownership distort decisions.');
  await page.getByRole('button', { name: 'Check for similar Nuglets' }).click();
  await page.getByText('Related Nuglets found').waitFor();
  assert.match(await page.locator('#nuglet-similarity-matches').textContent() ?? '', /smart people make bad decisions/i);
  assert.equal(await start.isDisabled(), true);

  await page.locator('[name="confirmDistinct"]').check();
  await page.locator('[name="notebookLmNotebookId"]').fill('fresh-notebook-id');
  assert.equal(await start.isEnabled(), true);

  await page.locator('[name="title"]').fill("Predictably Irrational Decisions");
  assert.equal(await start.isDisabled(), true);
  await page.getByRole('button', { name: 'Check for similar Nuglets' }).click();
  await page.locator('[name="confirmDistinct"]').check();
  assert.equal(await start.isEnabled(), true);
  await start.click();
  await page.getByText('Research started.').waitFor();

  assert.equal(similarityCsrf, 'pipeline-browser-csrf');
  assert.equal(createdRequest.notebookLmNotebookId, 'fresh-notebook-id');
  assert.deepEqual(createdRequest.brief.intake.similarityReview, {
    fingerprint,
    decision: 'proceed_distinct',
  });
});

function emptyPipeline() {
  return {
    daily: {
      day: '2026-07-27',
      timezone: 'Europe/Madrid',
      target: 5,
      started: 0,
      readyForReview: 0,
      approvedInFlight: 0,
      delivered: 0,
      remaining: 5,
    },
    counts: {
      research: 0,
      create: 0,
      check: 0,
      produce_assets: 0,
      human_review: 0,
      deliver: 0,
      delivering: 0,
      needsHuman: 0,
      active: 0,
      completed: 0,
      rejected: 0,
      duplicates: 0,
      blocked: 0,
      retrying: 0,
    },
    runs: [],
  };
}

function fixtureHtml() {
  return `<!doctype html>
    <html><head><meta name="review-csrf-token" content="pipeline-browser-csrf"></head><body>
      <p id="pipeline-summary"></p>
      <section id="daily-progress"></section>
      <section id="operations"></section>
      <section id="status-counts"></section>
      <section id="stage-counts"></section>
      <section id="pipeline-runs"></section>
      <p id="pipeline-error" hidden></p>
      <button id="pipeline-refresh" type="button">Refresh</button>
      <form id="new-nuglet-form">
        <input name="title" required>
        <textarea name="objective" required></textarea>
        <input name="audience" value="general adult learners" required>
        <input name="locale" value="en" required>
        <input name="notebookLmNotebookId" required>
        <textarea name="sourceUrls"></textarea>
        <button id="nuglet-similarity-check" type="button">Check for similar Nuglets</button>
        <p id="nuglet-similarity-status"></p>
        <section id="nuglet-similarity-results" hidden>
          <h3 id="nuglet-similarity-heading"></h3>
          <ul id="nuglet-similarity-matches"></ul>
          <label id="nuglet-distinct-confirmation" hidden><input type="checkbox" name="confirmDistinct">Distinct angle</label>
        </section>
        <button id="new-nuglet-submit" type="submit" disabled>Start research</button>
        <p id="new-nuglet-status"></p>
      </form>
      <script type="module">
        import { mountPipelinePage } from '/pipeline-client.mjs';
        mountPipelinePage();
      </script>
    </body></html>`;
}
