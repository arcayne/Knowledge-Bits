import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ArtifactStorageOperationError,
  ArtifactUploadCapabilityError,
  LocalFilesystemArtifactStorageAdapter,
} from './artifacts.js';

test('local artifact storage rejects traversal and malformed keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-bits-artifacts-'));
  try {
    const storage = new LocalFilesystemArtifactStorageAdapter({
      root,
      uploadBaseUrl: 'http://127.0.0.1:4321',
    });
    await assert.rejects(
      () => storage.preparePut({ storageKey: '../outside', mediaType: 'text/plain', expiresInSeconds: 60 }),
      ArtifactStorageOperationError,
    );
    await assert.rejects(
      () => storage.inspect('knowledge-bits/../outside'),
      ArtifactStorageOperationError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local artifact storage claims a capability before concurrent uploads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-bits-artifacts-'));
  try {
    const storage = new LocalFilesystemArtifactStorageAdapter(
      { root, uploadBaseUrl: 'http://127.0.0.1:4321' },
      { tokenGenerator: () => 'concurrent-upload-token' },
    );
    await storage.preparePut({
      storageKey: 'knowledge-bits/nuglet/run-concurrent/1/artifact-1',
      mediaType: 'application/octet-stream',
      expiresInSeconds: 60,
    });
    const bytesA = new TextEncoder().encode('first upload');
    const bytesB = new TextEncoder().encode('second upload');
    const results = await Promise.allSettled([
      storage.upload('concurrent-upload-token', bytesA, 'application/octet-stream'),
      storage.upload('concurrent-upload-token', bytesB, 'application/octet-stream'),
    ]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.ok(rejected && rejected.reason instanceof ArtifactUploadCapabilityError);
    const finalBytes = new Uint8Array(await storage.read('knowledge-bits/nuglet/run-concurrent/1/artifact-1'));
    assert.ok(Buffer.from(finalBytes).equals(Buffer.from(bytesA)) || Buffer.from(finalBytes).equals(Buffer.from(bytesB)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local artifact storage uploads, inspects, reads, and consumes a capability once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-bits-artifacts-'));
  try {
    let now = 1_000;
    const storage = new LocalFilesystemArtifactStorageAdapter(
      { root, uploadBaseUrl: 'http://127.0.0.1:4321' },
      { now: () => now, tokenGenerator: () => 'upload-token' },
    );
    const prepared = await storage.preparePut({
      storageKey: 'knowledge-bits/nuglet/run-1/1/artifact-1',
      mediaType: 'application/json',
      expiresInSeconds: 60,
    });
    assert.equal(prepared.uploadUrl, 'http://127.0.0.1:4321/artifacts/upload/upload-token');
    const bytes = new TextEncoder().encode('{"ok":true}');
    await storage.upload('upload-token', bytes, 'application/json');
    assert.deepEqual(new Uint8Array(await storage.read('knowledge-bits/nuglet/run-1/1/artifact-1')), bytes);
    assert.deepEqual(await storage.inspect('knowledge-bits/nuglet/run-1/1/artifact-1'), {
      checksum: createHash('sha256').update(bytes).digest('hex'),
      byteSize: bytes.byteLength,
      mediaType: 'application/json',
    });
    await assert.rejects(
      () => storage.upload('upload-token', bytes, 'application/json'),
      ArtifactUploadCapabilityError,
    );
    const metadata = await readFile(join(root, 'knowledge-bits/nuglet/run-1/1/artifact-1.metadata.json'), 'utf8');
    assert.equal(metadata, JSON.stringify({ mediaType: 'application/json' }));
    now += 61_000;
    const expired = await storage.preparePut({
      storageKey: 'knowledge-bits/nuglet/run-1/1/artifact-2',
      mediaType: 'text/plain',
      expiresInSeconds: 60,
    });
    const expiredToken = new URL(expired.uploadUrl).pathname.split('/').at(-1)!;
    now += 61_000;
    await assert.rejects(
      () => storage.upload(expiredToken, new TextEncoder().encode('expired'), 'text/plain'),
      ArtifactUploadCapabilityError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
