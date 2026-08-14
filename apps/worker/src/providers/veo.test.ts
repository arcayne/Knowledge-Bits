import assert from 'node:assert/strict';
import test from 'node:test';

import { buildVeoRequest, resolveVeoConfig, VeoProviderError, VertexVeoProvider } from './veo.js';

const videoBytes = Buffer.from('fake-mp4');

test('resolves Vertex Veo configuration without using the Gemini API key', () => {
  const config = resolveVeoConfig({
    GOOGLE_CLOUD_PROJECT_VEO: 'video-project',
    GOOGLE_CLOUD_LOCATION_VEO: 'us-central1',
    VEO_VERTEX_MODEL: 'veo-3.1-lite-generate-001',
    GEMINI_API_KEY: 'must-not-be-read',
  });
  assert.deepEqual(config, {
    project: 'video-project', location: 'us-central1', model: 'veo-3.1-lite-generate-001',
    outputRoot: 'tmp/veo', pollIntervalMs: 10_000, pollTimeoutMs: 720_000,
  });
});

test('builds a portrait image-to-video request with safe defaults', () => {
  const request = buildVeoRequest({ prompt: 'One red ball rolls smoothly into the only open space.', imageBytes: Buffer.from('png'), imageMimeType: 'image/png' }, 'veo-3.1-lite-generate-001');
  assert.equal(request.model, 'veo-3.1-lite-generate-001');
  assert.equal(request.prompt, 'One red ball rolls smoothly into the only open space.');
  assert.deepEqual(request.config, { numberOfVideos: 1, aspectRatio: '9:16', resolution: '720p', durationSeconds: 8, generateAudio: false });
  assert.deepEqual(request.image, { imageBytes: Buffer.from('png').toString('base64'), mimeType: 'image/png' });
});

test('rejects invalid Veo request configuration', () => {
  assert.throws(() => buildVeoRequest({ prompt: 'x', durationSeconds: 5 as never }, 'veo'), (error: unknown) => error instanceof VeoProviderError && error.code === 'veo_duration_invalid');
  assert.throws(() => buildVeoRequest({ prompt: 'x', imageBytes: Buffer.from('x') }, 'veo'), (error: unknown) => error instanceof VeoProviderError && error.code === 'veo_image_mime_type_invalid');
});

test('polls a completed operation and returns inline video bytes', async () => {
  const calls: unknown[] = [];
  const provider = new VertexVeoProvider({ project: 'project', location: 'us-central1', model: 'veo', outputRoot: 'tmp/veo', pollIntervalMs: 1, pollTimeoutMs: 100 }, {
    models: { async generateVideos(request) { calls.push(request); return { name: 'operations/1', done: false }; } },
    operations: { async getVideosOperation() { return { name: 'operations/1', done: true, response: { generatedVideos: [{ video: { videoBytes: videoBytes.toString('base64') } }] } }; } },
  }, async () => undefined);
  const result = await provider.generate({ prompt: 'A single continuous action.' });
  assert.equal(calls.length, 1);
  assert.equal(result.operationName, 'operations/1');
  assert.deepEqual(Buffer.from(result.bytes), videoBytes);
});

test('fails closed on provider errors, timeouts, and missing output bytes', async () => {
  const config = { project: 'project', location: 'us-central1', model: 'veo', outputRoot: 'tmp/veo', pollIntervalMs: 1, pollTimeoutMs: 10 } as const;
  const providerError = new VertexVeoProvider(config, { models: { async generateVideos() { return { name: 'operations/error', done: true, error: { code: 13 } }; } }, operations: { async getVideosOperation() { return {}; } } });
  await assert.rejects(() => providerError.generate({ prompt: 'x' }), /veo_generation_failed/);
  const missingBytes = new VertexVeoProvider(config, { models: { async generateVideos() { return { name: 'operations/missing', done: true, response: {} }; } }, operations: { async getVideosOperation() { return {}; } } });
  await assert.rejects(() => missingBytes.generate({ prompt: 'x' }), /veo_output_bytes_missing/);
  const timeout = new VertexVeoProvider(config, { models: { async generateVideos() { return { name: 'operations/pending', done: false }; } }, operations: { async getVideosOperation() { return { name: 'operations/pending', done: false }; } } }, async () => undefined);
  await assert.rejects(() => timeout.generate({ prompt: 'x' }), /veo_generation_timeout/);
});
