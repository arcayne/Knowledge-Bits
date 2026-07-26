import assert from 'node:assert/strict';
import test from 'node:test';

import { NotebookLmSourceRecorder } from './notebooklm-source-recorder.js';

test('records NotebookLM-selected sources without downloading source documents', async () => {
  const recorder = new NotebookLmSourceRecorder({ now: () => new Date('2026-07-16T10:00:00.000Z') });
  const result = await recorder.verify({
    sources: [{
      sourceId: 'notebooklm-source-1',
      title: 'A scholarly PDF selected by NotebookLM',
      url: 'https://research.example.edu/study.pdf',
    }],
  }, new AbortController().signal);

  assert.equal(result.evidence.acceptedSources.length, 1);
  assert.equal(result.evidence.acceptedSources[0]?.credibility.policy, 'notebooklm-source-selection.v1');
  assert.equal(result.snapshots[0]?.mediaType, 'application/json');
  assert.deepEqual(JSON.parse(Buffer.from(result.snapshots[0]!.body).toString('utf8')), {
    schemaVersion: 'notebooklm.source-receipt.v1',
    sourceId: 'notebooklm-source-1',
    title: 'A scholarly PDF selected by NotebookLM',
    url: 'https://research.example.edu/study.pdf',
    selectedAt: '2026-07-16T10:00:00.000Z',
  });
});

test('rejects invalid and duplicate NotebookLM source records', async () => {
  const result = await new NotebookLmSourceRecorder().verify({
    sources: [
      { sourceId: 'one', title: 'Invalid', url: 'not-a-url' },
      { sourceId: 'two', title: 'First', url: 'https://research.example.edu/study' },
      { sourceId: 'three', title: 'Duplicate', url: 'https://research.example.edu/study' },
    ],
  }, new AbortController().signal);

  assert.equal(result.evidence.acceptedSources.length, 1);
  assert.deepEqual(result.evidence.rejectedSources.map((source) => source.readability.reason), ['invalid_url', 'duplicate_url']);
});
