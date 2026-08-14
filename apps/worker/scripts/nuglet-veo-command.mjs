import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function checksum(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function parseInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('veo_input_invalid');
  const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : '';
  if (!prompt) throw new Error('veo_prompt_missing');
  return {
    prompt,
    ...(typeof value.imagePath === 'string' && value.imagePath.trim() ? { imagePath: value.imagePath.trim() } : {}),
    ...(typeof value.runId === 'string' && value.runId.trim() ? { runId: value.runId.trim() } : {}),
    ...(typeof value.inputChecksum === 'string' && value.inputChecksum.trim() ? { inputChecksum: value.inputChecksum.trim() } : {}),
    ...(value.aspectRatio === undefined ? {} : { aspectRatio: value.aspectRatio }),
    ...(value.resolution === undefined ? {} : { resolution: value.resolution }),
    ...(value.durationSeconds === undefined ? {} : { durationSeconds: value.durationSeconds }),
    ...(value.numberOfVideos === undefined ? {} : { numberOfVideos: value.numberOfVideos }),
    ...(value.generateAudio === undefined ? {} : { generateAudio: value.generateAudio }),
  };
}

export function sanitizedRequest(input, config, imageChecksum) {
  return {
    provider: 'vertex',
    model: config.model,
    project: config.project,
    location: config.location,
    prompt: input.prompt,
    ...(imageChecksum ? { imageChecksum } : {}),
    config: {
      aspectRatio: input.aspectRatio ?? '9:16',
      resolution: input.resolution ?? '720p',
      durationSeconds: input.durationSeconds ?? 8,
      numberOfVideos: input.numberOfVideos ?? 1,
      generateAudio: input.generateAudio ?? false,
    },
  };
}

export async function materializeVeoResult({ result, input, config, outputDirectory, probeVideo = probeWithFfprobe }) {
  await mkdir(outputDirectory, { recursive: true });
  const videoPath = join(outputDirectory, 'result.mp4');
  await writeFile(videoPath, result.bytes);
  const probe = await probeVideo(videoPath);
  if (probe.mediaType !== 'video/mp4' || probe.width <= 0 || probe.height <= 0 || probe.durationSeconds <= 0) {
    throw new Error('veo_output_media_invalid');
  }
  const outputChecksum = checksum(result.bytes);
  const metadata = {
    status: 'needs_review',
    provider: 'vertex',
    model: config.model,
    project: config.project,
    location: config.location,
    operationName: result.operationName,
    prompt: input.prompt,
    promptChecksum: checksum(Buffer.from(input.prompt)),
    ...(input.inputChecksum ? { inputChecksum: input.inputChecksum } : {}),
    ...(input.imageChecksum ? { imageChecksum: input.imageChecksum } : {}),
    outputChecksum,
    byteSize: result.bytes.byteLength,
    mediaType: 'video/mp4',
    width: probe.width,
    height: probe.height,
    durationSeconds: probe.durationSeconds,
    review: { decision: 'pending' },
  };
  await writeFile(join(outputDirectory, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  return {
    status: 'needs_review',
    assets: [{ kind: 'veo_source_video', mediaType: 'video/mp4', path: videoPath, bytes: result.bytes.byteLength, checksum: outputChecksum, metadata }],
  };
}

export async function probeWithFfprobe(path) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_type,width,height:format=duration,format_name',
    '-of', 'json', path,
  ]);
  const parsed = JSON.parse(stdout);
  const stream = parsed.streams?.[0];
  const format = parsed.format;
  const formatName = String(format?.format_name ?? '');
  if (stream?.codec_type !== 'video' || !formatName.split(',').includes('mp4')) throw new Error('veo_output_media_invalid');
  return { mediaType: 'video/mp4', width: Number(stream.width), height: Number(stream.height), durationSeconds: Number(format.duration) };
}

async function loadProvider() {
  try {
    return await import('../dist/providers/veo.js');
  } catch {
    throw new Error('veo_provider_not_built_run_worker_build_first');
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function outputDirectory(config, input) {
  const runId = (input.runId ?? 'prototype').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120) || 'prototype';
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return join(isAbsolute(config.outputRoot) ? config.outputRoot : resolve(config.outputRoot), runId, stamp);
}

export async function main({ providerFactory, input: rawInput, config: providedConfig, outputRoot } = {}) {
  const { resolveVeoConfig, VertexVeoProvider } = await loadProvider();
  const config = providedConfig ?? resolveVeoConfig(process.env);
  const input = parseInput(rawInput ?? await readStdin());
  let imageBytes;
  let imageChecksum;
  if (input.imagePath) {
    const imagePath = resolve(input.imagePath);
    if (extname(imagePath).toLowerCase() !== '.png') throw new Error('veo_image_must_be_png');
    if (!existsSync(imagePath)) throw new Error('veo_image_missing');
    imageBytes = await readFile(imagePath);
    imageChecksum = checksum(imageBytes);
  }
  const directory = outputRoot ?? outputDirectory(config, input);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'request.json'), `${JSON.stringify(sanitizedRequest(input, config, imageChecksum), null, 2)}\n`);
  const provider = providerFactory?.(config) ?? new VertexVeoProvider(config);
  const result = await provider.generate({
    prompt: input.prompt,
    ...(imageBytes ? { imageBytes, imageMimeType: 'image/png' } : {}),
    ...(input.aspectRatio === undefined ? {} : { aspectRatio: input.aspectRatio }),
    ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
    ...(input.durationSeconds === undefined ? {} : { durationSeconds: input.durationSeconds }),
    ...(input.numberOfVideos === undefined ? {} : { numberOfVideos: input.numberOfVideos }),
    ...(input.generateAudio === undefined ? {} : { generateAudio: input.generateAudio }),
  });
  await writeFile(join(directory, 'operation.json'), `${JSON.stringify(result.operation, null, 2)}\n`);
  const materialized = await materializeVeoResult({ result, input: { ...input, ...(imageChecksum ? { imageChecksum } : {}) }, config, outputDirectory: directory });
  process.stdout.write(`${JSON.stringify(materialized)}\n`);
  return materialized;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
