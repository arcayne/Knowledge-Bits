import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DeliveryPermanentSchemaError,
  DeliveryTransientError,
} from '../delivery.js';
import { createHttpDeliveryAdapterFromEnv, HttpDeliveryAdapter } from './http.js';
import type { DeliveryAdapterInput } from './types.js';
import { strictPackageVersionInput } from '../../testing/knowledge-bits-fixture.js';

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

test('delivery adapter remains disabled when no destination is configured', () => {
  assert.equal(createHttpDeliveryAdapterFromEnv({}), undefined);
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

test('HTTP delivery aborts bounded destination work as a transient timeout', async () => {
  const adapter = new HttpDeliveryAdapter({
    baseUrl: 'https://destination.example.test',
    timeoutMs: 5,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }),
  });

  await assert.rejects(adapter.deliver(input()), /timeout/i);
});

function input(): DeliveryAdapterInput {
  const packageId = '22222222-2222-4222-8222-222222222222';
  const packageVersionId = '11111111-1111-4111-8111-111111111111';
  const version = strictPackageVersionInput(packageId, 'http-adapter');
  return {
    packageVersionId,
    packageChecksum: version.packageChecksum,
    idempotencyKey: 'stable-operation',
    knowledgeBits: {
      id: packageVersionId,
      schemaVersion: 'knowledge-bits.review-package.v1',
      packageId,
      revision: version.revision,
      packageChecksum: version.packageChecksum,
      adapterVersion: version.adapterVersion,
      locale: version.locale,
      owner: version.owner,
      usageRights: version.usageRights,
      content: version.content,
      evidence: version.evidence,
      qa: version.qa,
      artifactInventory: version.artifactInventory,
      approval: {
        status: 'approved',
        reviewerId: 'editor',
        decidedAt: '2026-07-13T10:00:00.000Z',
        approvedChecksum: version.packageChecksum,
        comment: null,
      },
    },
  };
}
