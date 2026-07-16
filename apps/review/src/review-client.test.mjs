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
    'renderQuiz',
    'renderEvidence',
    'renderQa',
    'renderGenerationExecutions',
  ];
  let previous = -1;
  for (const signal of orderedSignals) {
    const current = source.indexOf(signal);
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
    '#title', '#status', '#checksum', '#review', '#story-title', '#story-meta', '#story-blocks',
    '#playbook-title', '#playbook-principle', '#hero', '#infographic', '#audio-brief',
    '#audio-discussion', '#audio-brief-transcript', '#audio-discussion-transcript', '#accepted-sources',
    '#rejected-sources', '#coverage-gaps', '#claims', '#qa', '#qa-findings',
    '#generation-executions', '#claim-coverage', '#editorial-warnings',
  ]) add(selector);

  return {
    approve,
    requestChanges,
    createElement: () => new ReviewElement(),
    querySelector: (selector) => selectors.get(selector) ?? null,
    querySelectorAll: () => [approve, requestChanges, changeSubmit],
  };
}
