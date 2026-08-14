import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { checksum, materializeVeoResult, parseInput, sanitizedRequest } from './nuglet-veo-command.mjs';

test('parses a bounded prototype input and sanitizes request metadata', () => {
  const input = parseInput({ prompt: 'One object moves continuously.', imagePath: './scene.png', runId: 'run-1', generateAudio: false });
  const config = { model: 'veo-3.1-lite-generate-001', project: 'project', location: 'us-central1' };
  const request = sanitizedRequest(input, config, checksum(Buffer.from('image')));
  assert.equal(input.prompt, 'One object moves continuously.');
  assert.equal(request.imageChecksum, checksum(Buffer.from('image')));
  assert.equal('apiKey' in request, false);
  assert.equal('token' in request, false);
});

test('writes a review-ready source-video sidecar with checksums and dimensions', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'kb-veo-test-'));
  const bytes = Buffer.from('fixture-video');
  const result = await materializeVeoResult({
    result: { bytes, operation: { name: 'operations/1' }, operationName: 'operations/1' },
    input: { prompt: 'One object moves continuously.' },
    config: { model: 'veo-3.1-lite-generate-001', project: 'project', location: 'us-central1' },
    outputDirectory,
    probeVideo: async () => ({ mediaType: 'video/mp4', width: 720, height: 1280, durationSeconds: 8 }),
  });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.assets[0].kind, 'veo_source_video');
  assert.equal(result.assets[0].checksum, checksum(bytes));
  const metadata = JSON.parse(await readFile(join(outputDirectory, 'metadata.json'), 'utf8'));
  assert.equal(metadata.status, 'needs_review');
  assert.equal(metadata.operationName, 'operations/1');
  assert.equal(metadata.width, 720);
  assert.equal(metadata.height, 1280);
  assert.equal(metadata.durationSeconds, 8);
});
