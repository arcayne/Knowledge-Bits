import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DeliveryPermanentSchemaError } from '../delivery.js';
import { createDeliveryAdapterFromEnv, LocalDeliveryAdapter } from './local.js';
import type { DeliveryAdapterInput } from './types.js';

const input: DeliveryAdapterInput = {
  knowledgeBits: {} as DeliveryAdapterInput['knowledgeBits'],
  packageVersionId: 'package-version-1',
  packageChecksum: 'checksum-a',
  idempotencyKey: 'delivery-key-1',
};

test('local delivery persists a receipt and is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-bits-delivery-'));
  try {
    const adapter = new LocalDeliveryAdapter({ root });
    const first = await adapter.deliver(input);
    const second = await adapter.deliver(input);
    assert.equal(first.status, 'imported');
    assert.deepEqual(second, { ...first, status: 'already_imported' });
    assert.equal((await readdir(join(root, 'delivery-receipts'))).length, 1);
    const verified = await adapter.verify({ externalId: first.externalId, packageChecksum: input.packageChecksum });
    assert.deepEqual(verified, { matches: true, url: first.previewUrl });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local delivery installs a receipt atomically for a fresh adapter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-bits-delivery-'));
  try {
    const first = await new LocalDeliveryAdapter({ root }).deliver(input);
    const freshAdapter = new LocalDeliveryAdapter({ root });
    const repeated = await freshAdapter.deliver(input);
    assert.deepEqual(repeated, { ...first, status: 'already_imported' });
    assert.deepEqual(
      await freshAdapter.verify({ externalId: first.externalId, packageChecksum: input.packageChecksum }),
      { matches: true, url: first.previewUrl },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local delivery rejects reuse with a different checksum', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-bits-delivery-'));
  try {
    const adapter = new LocalDeliveryAdapter({ root });
    await adapter.deliver(input);
    await assert.rejects(
      () => adapter.deliver({ ...input, packageChecksum: 'checksum-b' }),
      (error: unknown) => error instanceof DeliveryPermanentSchemaError && error.message === 'local_delivery_checksum_mismatch',
    );
    const verification = await adapter.verify({ externalId: 'local-missing', packageChecksum: input.packageChecksum });
    assert.equal(verification.matches, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local delivery configuration is explicit and can share the artifact root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-bits-delivery-'));
  try {
    const adapter = createDeliveryAdapterFromEnv({
      DELIVERY_ADAPTER_MODE: 'local',
      ARTIFACT_STORAGE_FILESYSTEM_ROOT: root,
    });
    assert.ok(adapter instanceof LocalDeliveryAdapter);
    await adapter.deliver(input);
    assert.equal((await readdir(join(root, 'delivery-receipts'))).length, 1);
    assert.throws(
      () => createDeliveryAdapterFromEnv({ DELIVERY_ADAPTER_MODE: 'local' }),
      /DELIVERY_ADAPTER_MODE=local requires: DELIVERY_ADAPTER_FILESYSTEM_ROOT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
