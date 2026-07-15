import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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
