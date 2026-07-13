import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DeliveryPermanentSchemaError,
  DeliveryTransientError,
} from '../delivery.js';
import { HttpDeliveryAdapter } from './http.js';
import type { DeliveryAdapterInput } from './types.js';

test('HTTP delivery sends the immutable package identity', async () => {
  let requestBody: unknown;
  const adapter = new HttpDeliveryAdapter({
    baseUrl: 'https://destination.example.test',
    token: 'destination-token',
    fetch: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ error: 'temporarily unavailable' }), { status: 503 });
    },
  });

  await assert.rejects(adapter.deliver(input()), DeliveryTransientError);
  assert.equal((requestBody as DeliveryAdapterInput).packageVersionId, input().packageVersionId);
  assert.equal((requestBody as DeliveryAdapterInput).packageChecksum, input().packageChecksum);
});

for (const status of [400, 401, 403, 404, 409, 422]) {
  test(`HTTP delivery treats ${status} as a human-required destination failure`, async () => {
    const adapter = new HttpDeliveryAdapter({
      baseUrl: 'https://destination.example.test',
      fetch: async () => new Response(JSON.stringify({ error: 'operator action required' }), { status }),
    });

    await assert.rejects(adapter.deliver(input()), DeliveryPermanentSchemaError);
  });
}

for (const status of [408, 429, 500, 503]) {
  test(`HTTP delivery treats ${status} as a transient destination failure`, async () => {
    const adapter = new HttpDeliveryAdapter({
      baseUrl: 'https://destination.example.test',
      fetch: async () => new Response(JSON.stringify({ error: 'retry later' }), { status }),
    });

    await assert.rejects(adapter.deliver(input()), DeliveryTransientError);
  });
}

test('HTTP delivery treats malformed success and error payloads deliberately', async () => {
  const malformedSuccess = new HttpDeliveryAdapter({
    baseUrl: 'https://destination.example.test',
    fetch: async () => Response.json({ externalId: 'missing-fields' }),
  });
  await assert.rejects(malformedSuccess.deliver(input()), DeliveryPermanentSchemaError);

  const malformedSuccessJson = new HttpDeliveryAdapter({
    baseUrl: 'https://destination.example.test',
    fetch: async () => new Response('{not-json', { status: 200 }),
  });
  await assert.rejects(malformedSuccessJson.deliver(input()), DeliveryPermanentSchemaError);

  const malformedPermanentError = new HttpDeliveryAdapter({
    baseUrl: 'https://destination.example.test',
    fetch: async () => new Response('{not-json', { status: 401 }),
  });
  await assert.rejects(malformedPermanentError.deliver(input()), DeliveryPermanentSchemaError);

  const malformedTransientError = new HttpDeliveryAdapter({
    baseUrl: 'https://destination.example.test',
    fetch: async () => new Response('{not-json', { status: 503 }),
  });
  await assert.rejects(malformedTransientError.deliver(input()), DeliveryTransientError);
});

function input(): DeliveryAdapterInput {
  return {
    packageVersionId: '11111111-1111-4111-8111-111111111111',
    packageChecksum: 'a'.repeat(64),
    idempotencyKey: 'stable-operation',
    knowledgeBits: {
      id: '11111111-1111-4111-8111-111111111111',
      schemaVersion: 'knowledge-bits.review-package.v1',
      packageId: '22222222-2222-4222-8222-222222222222',
      revision: 1,
      packageChecksum: 'a'.repeat(64),
      adapterVersion: 'knowledge-bits.review-package.v1',
      locale: 'en',
      owner: 'knowledge-bits-engine',
      usageRights: { scope: 'internal-review' },
      content: { schemaVersion: 'knowledge-bits.content.v1', target: { kind: 'nuglet.lesson.v1', payload: { title: 'Test' } } },
      evidence: {
        schemaVersion: 'knowledge-bits.evidence.v1',
        sources: [{ sourceId: '33333333-3333-4333-8333-333333333333', url: 'https://example.test', title: 'Source', retrievedAt: '2026-07-13T09:00:00.000Z', checksum: 'b'.repeat(64) }],
        claims: [{ claimId: '44444444-4444-4444-8444-444444444444', statement: 'Claim', citations: [{ sourceId: '33333333-3333-4333-8333-333333333333', excerpt: 'Evidence' }] }],
      },
      qa: { deterministic: { passed: true, findings: [] }, editorial: { summary: 'Ready', findings: [] } },
      artifactInventory: [],
      approval: { status: 'approved', reviewerId: 'editor', decidedAt: '2026-07-13T10:00:00.000Z', approvedChecksum: 'a'.repeat(64), comment: null },
    },
  };
}
