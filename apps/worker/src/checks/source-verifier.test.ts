import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { DeterministicSourceVerifier } from './source-verifier.js';

const acceptedId = '11111111-1111-4111-8111-111111111111';
const rejectedId = '22222222-2222-4222-8222-222222222222';

test('accepts readable trusted sources, rejects untrusted sources, and snapshots exact bytes', async () => {
  const fetched: string[] = [];
  const snapshot = Buffer.from('<article>' + 'A concrete next action reduces restart friction. '.repeat(4) + '</article>');
  const verifier = new DeterministicSourceVerifier({
    trustedHosts: ['trusted.example.test'],
    now: () => new Date('2026-07-13T10:00:00.000Z'),
    fetch: async (url) => {
      fetched.push(String(url));
      return new Response(snapshot, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    },
  });

  const result = await verifier.verify({
    sources: [
      { sourceId: acceptedId, title: 'Trusted evidence', url: 'https://trusted.example.test/evidence' },
      { sourceId: rejectedId, title: 'Untrusted evidence', url: 'https://untrusted.example.test/evidence' },
    ],
  }, new AbortController().signal);

  assert.deepEqual(fetched, ['https://trusted.example.test/evidence']);
  assert.equal(result.evidence.acceptedSources.length, 1);
  assert.equal(result.evidence.rejectedSources.length, 1);
  assert.equal(result.evidence.rejectedSources[0]?.credibility.reason, 'host_not_trusted');
  assert.equal(result.snapshots.length, 1);
  assert.equal(Buffer.from(result.snapshots[0]!.body).toString(), snapshot.toString());
  assert.equal(result.snapshots[0]?.provenance?.sourceId, acceptedId);
  assert.equal(result.evidence.acceptedSources[0]?.snapshotChecksum, createHash('sha256').update(snapshot).digest('hex'));
});

test('records unreadable and duplicate candidates as rejected coverage gaps', async () => {
  const verifier = new DeterministicSourceVerifier({
    trustedHosts: ['trusted.example.test'],
    fetch: async () => new Response('too short', { headers: { 'Content-Type': 'text/plain' } }),
  });

  const result = await verifier.verify({
    sources: [
      { sourceId: acceptedId, title: 'Thin evidence', url: 'https://trusted.example.test/evidence' },
      { sourceId: rejectedId, title: 'Duplicate evidence', url: 'https://trusted.example.test/evidence' },
    ],
  }, new AbortController().signal);

  assert.equal(result.evidence.acceptedSources.length, 0);
  assert.deepEqual(result.evidence.rejectedSources.map((source) => source.readability.reason), [
    'content_too_short',
    'duplicate_url',
  ]);
  assert.ok(result.evidence.coverageGaps.length >= 2);
});
