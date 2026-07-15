import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { chromium } from 'playwright';

const checksum = 'a'.repeat(64);

test('browser renders the complete approved payload and submits its displayed checksum', { timeout: 30_000 }, async (t) => {
  let decision;
  let csrf;
  const clientSource = await readFile(new URL('./review-client.mjs', import.meta.url), 'utf8');
  const server = createServer(async (request, response) => {
    if (request.url === '/review-client.mjs') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(clientSource);
      return;
    }
    if (request.url?.startsWith('/api/review') && request.method === 'GET') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(reviewModel()));
      return;
    }
    if (request.url === '/api/review' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      decision = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      csrf = request.headers['x-csrf-token'];
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ reviewStatus: 'approved' }));
      return;
    }
    if (request.url?.startsWith('/api/artifact')) {
      response.setHeader('Content-Type', request.url.includes('audio') ? 'audio/mp4' : 'image/webp');
      response.end('fixture-media');
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end(browserFixtureHtml());
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
  await page.waitForSelector('#review:not([hidden])');

  assert.equal(await page.locator('#story-title').textContent(), 'The expense before payday');
  assert.equal(await page.locator('#playbook-title').textContent(), 'Build a repeatable buffer');
  assert.equal(await page.locator('#audio-brief-transcript').textContent(), 'Brief final transcript.');
  assert.equal(await page.locator('#audio-discussion-transcript').textContent(), 'Discussion final transcript.');
  assert.equal(await page.locator('audio').count(), 2);
  assert.equal(await page.locator('.quiz-question').count(), 3);
  assert.equal(await page.locator('.crop-frame img').count(), 3);
  assert.equal(await page.getByRole('button', { name: 'Approve' }).count(), 1);
  assert.equal(await page.locator('#generation-provenance').evaluate((element) => element.hasAttribute('open')), false);
  assert.equal(await page.locator('#generation-executions a').count(), 21);
  assert.match(await page.locator('#claims').textContent() ?? '', /restart decisions/i);
  assert.equal(await page.locator('#checksum').textContent(), checksum);
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.waitForTimeout(100);

  assert.ok(decision);
  assert.equal(decision.packageChecksum, checksum);
  assert.equal(decision.decision, 'approve');
  assert.equal(csrf, 'browser-csrf-token');
});

function reviewModel() {
  const claimId = '11111111-1111-4111-8111-111111111111';
  const sourceId = '22222222-2222-4222-8222-222222222222';
  const snapshotArtifactId = '33333333-3333-4333-8333-333333333333';
  const payload = {
    materialization: 'materialized',
    read: {
      story: {
        title: 'The expense before payday',
        estimatedMinutes: 4,
        blocks: [
          { type: 'opening', text: 'A repair bill arrived.', claimRefs: [] },
          { type: 'turning_point', text: 'A small reserve changed the decision.', claimRefs: [claimId] },
          { type: 'practical_bridge', text: 'The first transfer stayed small.', claimRefs: [claimId] },
        ],
      },
      playbook: {
        title: 'Build a repeatable buffer',
        principle: 'Consistency matters more than size.',
        whyItMatters: 'A repeatable transfer avoids a new shortfall.',
        steps: [
          { title: 'Choose', body: 'Pick an affordable amount.' },
          { title: 'Separate', body: 'Move it aside.' },
          { title: 'Repeat', body: 'Schedule the next transfer.' },
        ],
        example: { title: 'Start with ten', body: 'Ten each week is valid.' },
        watchOuts: ['Do not create a new shortfall.'],
        action: 'Set aside one affordable amount.',
      },
    },
    hero: {
      altText: 'A vessel collecting coins beside a seedling.',
      width: 1200,
      height: 900,
      focalPoint: { x: 0.62, y: 0.44 },
      cropSafeArea: { x: 0.12, y: 0.1, width: 0.76, height: 0.8 },
    },
    visual: {
      altText: 'A loop showing choose, separate, and repeat.',
      textEquivalent: ['Choose an amount.', 'Separate the money.', 'Repeat the transfer.'],
    },
    listen: {
      brief: { transcript: { text: 'Brief final transcript.' } },
      discussion: { transcript: { text: 'Discussion final transcript.' } },
    },
    quiz: {
      questions: ['Central idea?', 'Practical action?', 'What should you avoid?'].map((prompt, index) => ({
        prompt,
        options: [{ id: 'a', text: 'Start small' }, { id: 'b', text: 'Wait' }, { id: 'c', text: 'Borrow' }],
        correctOptionId: 'a',
        rationale: `Rationale ${index + 1}.`,
      })),
    },
    claims: [{
      claimId,
      statement: 'A concrete next action reduces restart decisions.',
      citations: [{ sourceId, snapshotArtifactId, excerpt: 'A next action removes a restart decision.' }],
    }],
    claimCoverage: [
      'read.story', 'read.playbook', 'visual', 'listen.brief', 'listen.discussion', 'quiz',
    ].map((path) => ({ path, claimIds: [claimId] })),
  };
  const snapshot = {
    artifactId: snapshotArtifactId, kind: 'source_snapshot', mediaType: 'text/plain', checksum,
    storageKey: 'sources/accepted', byteSize: 120, createdAt: '2026-07-13T10:00:00.000Z', provider: 'fixture', inputChecksum: null,
  };
  return {
    runId: '44444444-4444-4444-8444-444444444444',
    title: 'Return to one task', currentStage: 'human_review', currentRevision: 1, reviewStatus: 'pending',
    currentPackageChecksum: checksum, decisionAllowed: true, issues: [],
    package: {
      packageChecksum: checksum,
      content: { target: { schemaVersion: '1.1.0', payload } },
      evidence: {
        acceptedSources: [{ sourceId, title: 'Accepted source', url: 'https://example.test', snapshot }],
        rejectedSources: [], coverageGaps: [], claims: payload.claims,
      },
      qa: { deterministic: { passed: true, findings: [] }, editorial: { summary: 'Ready.', findings: [] } },
    },
    assets: {
      hero: availableAsset('hero', 'image/webp'),
      infographic: availableAsset('infographic', 'image/webp'),
      audioBrief: availableAsset('audio-brief', 'audio/mp4'),
      audioDiscussion: availableAsset('audio-discussion', 'audio/mp4'),
    },
    generationExecutions: Object.fromEntries([
      ['story', 'nuglet.lesson.story'],
      ['playbook', 'nuglet.lesson.playbook'],
      ['quiz', 'nuglet.challenge'],
      ['hero', 'nuglet.hero'],
      ['infographic', 'nuglet.visual.infographic'],
      ['audioBrief', 'nuglet.audio.brief'],
      ['audioDiscussion', 'nuglet.audio.discussion'],
    ].map(([role, recipeId], index) => [role, [generationExecution(role, recipeId, index + 1)]])),
  };
}

function availableAsset(label, mediaType) {
  return {
    state: 'available',
    artifactId: `55555555-5555-4555-8555-${label === 'hero' ? '000000000001' : label === 'infographic' ? '000000000002' : label === 'audio-brief' ? '000000000003' : '000000000004'}`,
    mediaType,
  };
}

function generationExecution(role, recipeId, index) {
  const reference = (kind, suffix) => ({ artifactId: `66666666-6666-4666-8666-0000000000${index}${suffix}`, kind });
  return {
    role,
    recipe: { id: recipeId, version: '1.0.0', checksum: `sha256:${checksum}` },
    model: 'fixture-model',
    promptChecksum: `sha256:${checksum}`,
    referenceChecksums: role === 'hero' ? [`sha256:${checksum}`] : [],
    recipeSnapshot: reference('generation.recipe.snapshot', 1),
    renderedPrompt: reference('generation.prompt.rendered', 2),
    executionReport: reference('generation.execution.report', 3),
  };
}

function browserFixtureHtml() {
  return `<!doctype html><html><head><meta name="review-csrf-token" content="browser-csrf-token"></head><body>
    <main data-run-id="44444444-4444-4444-8444-444444444444"><h1 id="title"></h1><p id="status"></p><p id="checksum"></p><p id="error" hidden></p><div id="review" hidden>
      <section id="story-section"><h3 id="story-title"></h3><p id="story-meta"></p><div id="story-blocks"></div></section>
      <section id="playbook-section"><h3 id="playbook-title"></h3><p id="playbook-principle"></p><p id="playbook-why"></p><div id="playbook-steps"></div><div id="playbook-example"></div><ul id="playbook-watch-outs"></ul><p id="playbook-action"></p></section>
      <div id="hero"></div><p id="hero-alt"></p><p id="hero-metadata"></p><div class="crop-frame" id="hero-lesson-header"></div><div class="crop-frame" id="hero-card"></div><div class="crop-frame" id="hero-thumbnail"></div>
      <div id="infographic"></div><p id="infographic-alt"></p><ul id="infographic-text-equivalent"></ul>
      <div id="audio-brief"></div><p id="audio-brief-transcript"></p><div id="audio-discussion"></div><p id="audio-discussion-transcript"></p>
      <div id="quiz"></div><ul id="claim-coverage"></ul><ul id="accepted-sources"></ul><ul id="rejected-sources"></ul><ul id="coverage-gaps"></ul><ul id="claims"></ul>
      <p id="qa"></p><ul id="qa-findings"></ul><details id="generation-provenance"><summary>Generation provenance</summary><div id="generation-executions"></div></details>
    </div></main>
    <span id="decision-status"></span><button data-decision="approve" disabled>Approve</button><button data-decision="request_changes" disabled>Request changes</button>
    <form id="change-form"><textarea id="comment" name="comment"></textarea><button disabled>Send changes</button></form>
    <script type="module">import { mountReviewPage } from '/review-client.mjs'; mountReviewPage();</script>
  </body></html>`;
}
