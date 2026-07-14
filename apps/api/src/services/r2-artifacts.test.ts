import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import {
  ArtifactStorageObjectNotFoundError,
  ArtifactStorageOperationError,
} from './artifacts.js';
import {
  createArtifactStorageFromEnv,
  R2ArtifactStorageAdapter,
} from './r2-artifacts.js';

const config = {
  accountId: 'account-123',
  bucket: 'nuglet-media-prod',
  accessKeyId: 'access-key',
  secretAccessKey: 'secret-key',
  publicBaseUrl: 'https://media.nuglet.app',
};

test('prepares a signed R2 upload with server-owned metadata', async () => {
  const client = { send: async () => ({}) } as unknown as S3Client;
  let signedCommand: PutObjectCommand | undefined;
  let signedExpiry: number | undefined;
  const adapter = new R2ArtifactStorageAdapter(config, {
    client,
    presignPut: async (_client, command, options) => {
      signedCommand = command;
      signedExpiry = options.expiresIn;
      return 'https://r2.example.test/signed-upload';
    },
  });

  const prepared = await adapter.preparePut({
    storageKey: 'knowledge-bits/nuglet/run-1/1/artifact-1',
    mediaType: 'image/webp',
    expiresInSeconds: 900,
  });

  assert.equal(prepared.uploadUrl, 'https://r2.example.test/signed-upload');
  assert.deepEqual(prepared.requiredHeaders, { 'content-type': 'image/webp' });
  assert.equal(signedExpiry, 900);
  assert.ok(signedCommand instanceof PutObjectCommand);
  assert.deepEqual(signedCommand?.input, {
    Bucket: 'nuglet-media-prod',
    Key: 'knowledge-bits/nuglet/run-1/1/artifact-1',
    ContentType: 'image/webp',
  });
});

test('reads R2 bytes and derives immutable checksum metadata', async () => {
  const bytes = new TextEncoder().encode('knowledge bit');
  const client = {
    send: async (command: unknown) => {
      assert.ok(command instanceof GetObjectCommand);
      assert.equal(command.input.Bucket, 'nuglet-media-prod');
      assert.equal(command.input.Key, 'knowledge-bits/nuglet/run-1/1/artifact-1');
      return {
        Body: { transformToByteArray: async () => bytes },
        ContentType: 'application/json',
      };
    },
  } as unknown as S3Client;
  const adapter = new R2ArtifactStorageAdapter(config, { client });

  const inspected = await adapter.inspect('knowledge-bits/nuglet/run-1/1/artifact-1');
  assert.deepEqual(inspected, {
    checksum: createHash('sha256').update(bytes).digest('hex'),
    byteSize: bytes.byteLength,
    mediaType: 'application/json',
  });
  assert.deepEqual(await adapter.read('knowledge-bits/nuglet/run-1/1/artifact-1'), bytes);
});

test('maps R2 missing objects to a review-safe not-found error', async () => {
  const client = {
    send: async () => {
      throw Object.assign(new Error('missing'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      });
    },
  } as unknown as S3Client;
  const adapter = new R2ArtifactStorageAdapter(config, { client });

  await assert.rejects(
    () => adapter.read('knowledge-bits/nuglet/run-1/1/missing'),
    ArtifactStorageObjectNotFoundError,
  );
  await assert.rejects(
    () => adapter.inspect('knowledge-bits/nuglet/run-1/1/missing'),
    ArtifactStorageObjectNotFoundError,
  );
});

test('fails closed when R2 mode is enabled without backend credentials', () => {
  assert.throws(
    () => createArtifactStorageFromEnv({ ARTIFACT_STORAGE_MODE: 'r2' }),
    /ARTIFACT_STORAGE_MODE=r2 requires: accountId, accessKeyId, secretAccessKey/,
  );
  assert.ok(createArtifactStorageFromEnv({ ARTIFACT_STORAGE_MODE: 'unavailable' }));
});

test('maps non-not-found R2 failures to an operation error', async () => {
  const client = {
    send: async () => { throw new Error('R2 unavailable'); },
  } as unknown as S3Client;
  const adapter = new R2ArtifactStorageAdapter(config, { client });

  await assert.rejects(
    () => adapter.read('knowledge-bits/nuglet/run-1/1/artifact-1'),
    ArtifactStorageOperationError,
  );
});
