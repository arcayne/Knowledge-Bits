import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { mountReviewPage } from './review-client.mjs';

const client = new URL('./review-client.mjs', import.meta.url);

test('review client renders the complete Story Playbook package in review order', async () => {
  const source = await readFile(client, 'utf8');

  const orderedSignals = [
    'renderStory',
    'renderPlaybook',
    "renderAsset('hero'",
    "renderAsset('infographic'",
    "renderAudio('audio-brief'",
    "renderAudio('audio-discussion'",
    "renderVideo('public-preview'",
    'renderQuiz',
    'renderEvidence',
    'renderQa',
    'renderGenerationExecutions',
  ];
  let previous = source.indexOf('const load = async');
  for (const signal of orderedSignals) {
    const current = source.indexOf(signal, previous + 1);
    assert.ok(current > previous, `${signal} should render after the previous review surface`);
    previous = current;
  }
  assert.match(source, /payload\.read\.story/);
  assert.match(source, /payload\.read\.playbook/);
  assert.match(source, /payload\.quiz\.questions/);
  assert.match(source, /audioBrief/);
  assert.match(source, /audioDiscussion/);
  assert.match(source, /generationExecutions/);
});

test('review client keeps one package decision and requires a change comment', async () => {
  const source = await readFile(client, 'utf8');

  assert.match(source, /submit\('approve'\)/);
  assert.match(source, /submit\('request_changes'/);
  assert.match(source, /A comment is required to request changes/);
  assert.doesNotMatch(source, /artifactId[^\n]+decision/);
});

test('review client renders editorial warnings beside the overall decision without disabling it', async () => {
  const [clientSource, pageSource] = await Promise.all([
    readFile(client, 'utf8'),
    readFile(new URL('./pages/runs/[runId].astro', import.meta.url), 'utf8'),
  ]);

  assert.match(clientSource, /renderEditorialWarnings\(payload\.warnings\)/);
  assert.match(clientSource, /payload\.warnings/);
  assert.match(pageSource, /id="editorial-warnings"/);
  const decisionFooter = pageSource.slice(pageSource.indexOf('<footer'));
  assert.ok(decisionFooter.indexOf('editorial-warnings') > decisionFooter.indexOf('decision-status'));
  assert.doesNotMatch(clientSource, /warnings[^\n]+setDecisionAllowed/);
});

test('review client shows warning details while enabling both overall decisions', async () => {
  const page = reviewPageDocument();
  const payload = {
    title: 'Return to one task',
    currentStage: 'human_review',
    reviewStatus: 'pending',
    currentPackageChecksum: 'a'.repeat(64),
    decisionAllowed: true,
    issues: [],
    warnings: ['Editorial warning: unsupported-claim: A claim needs a stronger source.'],
    package: {
      packageChecksum: 'a'.repeat(64),
      content: {
        target: {
          schemaVersion: '1.0.0',
          payload: {
            title: 'Return to one task',
            takeaway: 'Name the next step.',
            action: 'Write it down.',
            depths: { quick: 'Name it.', core: 'Write it.', deep: 'Return to it.' },
            claimCoverage: [],
          },
        },
      },
      evidence: { acceptedSources: [], rejectedSources: [], coverageGaps: [], claims: [] },
      qa: { deterministic: { passed: true, findings: [] }, editorial: { summary: 'Review before publishing.', findings: [] } },
    },
    assets: {
      hero: { state: 'missing' },
      infographic: { state: 'missing' },
      audioBrief: { state: 'missing' },
      audioDiscussion: { state: 'missing' },
    },
    generationExecutions: {},
  };

  await mountReviewPage({
    document: page,
    fetch: async () => ({ ok: true, json: async () => payload }),
  });

  const warnings = page.querySelector('#editorial-warnings');
  assert.equal(warnings.hidden, false);
  assert.equal(warnings.children[1]?.children[0]?.textContent, payload.warnings[0]);
  assert.equal(page.approve.disabled, false);
  assert.equal(page.requestChanges.disabled, false);
});

test('review client replaces decision controls with delivery status after approval', async () => {
  const page = reviewPageDocument();
  const payload = {
    title: 'Protect Your Attention',
    currentStage: 'deliver',
    reviewStatus: 'approved',
    currentPackageChecksum: 'a'.repeat(64),
    decisionAllowed: true,
    issues: [],
    warnings: [],
    package: {
      packageChecksum: 'a'.repeat(64),
      content: {
        target: {
          schemaVersion: '1.0.0',
          payload: {
            title: 'Protect Your Attention',
            takeaway: 'Protect focus before interruptions arrive.',
            action: 'Choose one focus block.',
            depths: { quick: 'Choose.', core: 'Protect.', deep: 'Return.' },
            claimCoverage: [],
          },
        },
      },
      evidence: { acceptedSources: [], rejectedSources: [], coverageGaps: [], claims: [] },
      qa: { deterministic: { passed: true, findings: [] }, editorial: { summary: 'Approved.', findings: [] } },
    },
    assets: {
      hero: { state: 'missing' },
      infographic: { state: 'missing' },
      audioBrief: { state: 'missing' },
      audioDiscussion: { state: 'missing' },
    },
    generationExecutions: {},
  };

  await mountReviewPage({
    document: page,
    fetch: async () => ({ ok: true, json: async () => payload }),
  });

  assert.equal(page.querySelector('#decision-status').textContent, 'Approved, awaiting delivery.');
  assert.equal(page.approve.hidden, true);
  assert.equal(page.requestChanges.hidden, true);
  assert.equal(page.querySelector('#change-form').hidden, true);
});

test('review client replaces decision controls with terminal status after rejection', async () => {
  const page = reviewPageDocument();
  const payload = {
    title: 'Wrong topic',
    currentStage: 'human_review',
    reviewStatus: 'rejected',
    currentPackageChecksum: 'a'.repeat(64),
    decisionAllowed: false,
    issues: [],
    warnings: [],
    package: {
      packageChecksum: 'a'.repeat(64),
      content: {
        target: {
          schemaVersion: '1.0.0',
          payload: {
            title: 'Wrong topic',
            takeaway: 'This package was rejected.',
            action: 'Do not deliver it.',
            depths: { quick: 'Stop.', core: 'Reject.', deep: 'Preserve the audit.' },
            claimCoverage: [],
          },
        },
      },
      evidence: { acceptedSources: [], rejectedSources: [], coverageGaps: [], claims: [] },
      qa: { deterministic: { passed: true, findings: [] }, editorial: { summary: 'Wrong topic.', findings: [] } },
    },
    assets: {
      hero: { state: 'missing' },
      infographic: { state: 'missing' },
      audioBrief: { state: 'missing' },
      audioDiscussion: { state: 'missing' },
    },
    generationExecutions: {},
  };

  await mountReviewPage({
    document: page,
    fetch: async () => ({ ok: true, json: async () => payload }),
  });

  assert.equal(page.querySelector('#decision-status').textContent, 'Rejected and removed from the active pipeline.');
  assert.equal(page.approve.hidden, true);
  assert.equal(page.requestChanges.hidden, true);
  assert.equal(page.querySelector('#change-form').hidden, true);
});

test('review client renders partial generation progress before human review', async () => {
  const page = reviewPageDocument();
  const claimId = '11111111-1111-4111-8111-111111111111';
  const review = {
    package: null,
    warnings: [],
    reviewStatus: 'pending',
    decisionAllowed: false,
  };
  const preview = {
    run: {
      title: 'Offer engineering',
      currentStage: 'produce_assets',
      currentState: 'waiting',
      currentRevision: 2,
      reviewStatus: 'pending',
      reason: 'notebooklm_artifact_propagating',
    },
    documents: {
      evidence: {
        state: 'available',
        data: { acceptedSources: [], rejectedSources: [], coverageGaps: [] },
      },
      content: {
        state: 'available',
        data: {
          payload: {
            hero: { altText: 'A draft hero scene.' },
            visual: { altText: 'A draft visual.', textEquivalent: ['Choose value.', 'Reduce risk.'] },
            read: {
              playbook: {
                title: 'Build the offer',
                principle: 'Increase value before cutting price.',
                whyItMatters: 'Value changes the buying decision.',
                steps: [
                  { title: 'Choose', body: 'Choose the result.' },
                  { title: 'Reduce', body: 'Reduce delay.' },
                  { title: 'Support', body: 'Support confidence.' },
                ],
                example: { title: 'A clear bundle', body: 'Package the result.' },
                watchOuts: ['Do not rely on discounts.'],
                action: 'Write the offer.',
              },
            },
            quiz: {
              questions: [{
                prompt: 'What changes first?',
                options: [{ id: 'a', text: 'Value' }, { id: 'b', text: 'Logo' }, { id: 'c', text: 'Color' }],
                correctOptionId: 'a',
                rationale: 'Value changes the decision.',
              }],
            },
            claims: [{ claimId, statement: 'A stronger offer can reduce price sensitivity.' }],
            claimCoverage: [{ path: 'read.playbook', claimIds: [claimId] }],
          },
        },
      },
      qa: { state: 'missing', data: null },
    },
    media: [
      { kind: 'hero', state: 'missing' },
      { kind: 'infographic', state: 'missing' },
      { kind: 'audio_brief', state: 'missing' },
      { kind: 'audio_discussion', state: 'missing' },
    ],
  };
  const responses = [review, preview];

  await mountReviewPage({
    document: page,
    fetch: async () => ({ ok: true, json: async () => responses.shift() }),
  });

  assert.match(page.querySelector('#story-blocks').children[0]?.textContent ?? '', /Story has not been generated/);
  assert.equal(page.querySelector('#playbook-title').textContent, 'Build the offer');
  assert.equal(page.querySelector('#playbook-steps').children.length, 3);
  assert.equal(page.querySelector('#quiz').children.length, 1);
  assert.match(page.querySelector('#claims').children[0]?.textContent ?? '', /stronger offer/);
  assert.match(page.querySelector('#hero-alt').textContent, /Draft brief/);
  assert.match(page.querySelector('#decision-status').textContent, /Human review comes after generation and QA/);
});

class ReviewElement {
  children = [];
  content = '';
  dataset = {};
  disabled = false;
  hidden = false;
  textContent = '';

  constructor(input = {}) {
    Object.assign(this, input);
  }

  addEventListener() {}
  append(...children) { this.children.push(...children); }
  focus() {}
  replaceChildren(...children) { this.children = children; }
}

function reviewPageDocument() {
  const approve = new ReviewElement();
  const requestChanges = new ReviewElement();
  const changeSubmit = new ReviewElement();
  const selectors = new Map();
  const add = (selector, input) => {
    const element = new ReviewElement(input);
    selectors.set(selector, element);
    return element;
  };

  add('main[data-run-id]', { dataset: { runId: 'review-run' } });
  add('#error');
  add('#change-form', { dataset: {} });
  add('#comment');
  add('#decision-status');
  selectors.set('[data-decision="approve"]', approve);
  selectors.set('[data-decision="request_changes"]', requestChanges);
  add('meta[name="review-csrf-token"]', { content: 'csrf-token' });
  for (const selector of [
    '#title', '#status', '#checksum', '#review', '#run-summary', '#story-title', '#story-meta', '#story-blocks',
    '#playbook-title', '#playbook-principle', '#playbook-why', '#playbook-steps', '#playbook-example',
    '#playbook-watch-outs', '#playbook-action', '#hero', '#hero-alt', '#hero-metadata',
    '#hero-lesson-header', '#hero-card', '#hero-thumbnail', '#infographic', '#infographic-alt',
    '#infographic-text-equivalent', '#audio-brief', '#audio-discussion', '#audio-brief-transcript',
    '#audio-discussion-transcript', '#quiz', '#accepted-sources', '#rejected-sources', '#coverage-gaps',
    '#claims', '#qa', '#qa-findings', '#generation-executions', '#claim-coverage', '#editorial-warnings',
  ]) add(selector);

  return {
    approve,
    requestChanges,
    createElement: () => new ReviewElement(),
    querySelector: (selector) => selectors.get(selector) ?? null,
    querySelectorAll: () => [approve, requestChanges, changeSubmit],
  };
}
