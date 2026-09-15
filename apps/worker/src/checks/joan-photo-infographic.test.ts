import assert from 'node:assert/strict';
import test from 'node:test';

import { createJoanAiVideoBrief } from '@knowledge-bits/contracts';

import { validateJoanPhotoInfographicSeries } from './joan-photo-infographic.js';

const claimIds = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
];

test('accepts the fixture series when every card claim is checked', async () => {
  const { FixtureProvider } = await import('../providers/fixture.js');
  const provider = new FixtureProvider();
  const now = new Date().toISOString();
  const result = await provider.execute({
    job: {
      jobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      packageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      stage: 'produce_assets',
      claimedBy: 'test-worker',
      claimedAt: now,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      executionDeadlineAt: new Date(Date.now() + 300_000).toISOString(),
      attempt: 1,
      revision: 1,
      input: { brief: createJoanAiVideoBrief('https://www.youtube.com/watch?v=-QFHIoCo-Ko'), dependencies: [] },
    },
    action: 'produce_assets',
    idempotencyKey: 'joan-photo-infographic-fixture',
    signal: new AbortController().signal,
  });

  assert.equal(result.kind, 'success');
  if (result.kind !== 'success') return;
  const validation = validateJoanPhotoInfographicSeries({ series: result.parsedOutput, claimIds });
  assert.equal(validation.passed, true);
  assert.equal(validation.series?.cards.length, 4);
  assert.equal(result.assets?.length, 4);
  assert.deepEqual(result.assets?.map((asset) => asset.kind), validation.series?.cards.map((card) => card.assetKind));
});

test('rejects a card that references an unchecked claim', () => {
  const series = {
    contentKind: 'joan.photo-infographic-series.v1',
    schemaVersion: '1.0.0',
    sourceVideoId: '-QFHIoCo-Ko',
    format: { width: 1080, height: 1350, aspectRatio: '4:5' },
    selection: { cardCount: 4, rule: 'structure-driven-no-padding', rationale: 'Four units.' },
    cards: Array.from({ length: 4 }, (_, index) => ({
      sequence: index + 1,
      assetKind: `joan.photo-infographic.card.0${index + 1}`,
      title: `Card ${index + 1}`,
      body: `Body ${index + 1}`,
      visualDirection: `Direction ${index + 1}`,
      imagePrompt: `Prompt ${index + 1}`,
      altText: `Alt ${index + 1}`,
      textEquivalent: [`Equivalent ${index + 1}`],
      claimRefs: [index === 0 ? '99999999-9999-4999-8999-999999999999' : claimIds[index]],
    })),
  };

  const validation = validateJoanPhotoInfographicSeries({ series, claimIds });
  assert.equal(validation.passed, false);
  assert.equal(validation.findings[0]?.code, 'claim-reference');
});
