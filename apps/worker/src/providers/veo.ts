import { GoogleGenAI } from '@google/genai';

const DEFAULT_MODEL = 'veo-3.1-lite-generate-001';
const DEFAULT_LOCATION = 'us-central1';
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_POLL_TIMEOUT_MS = 12 * 60 * 1_000;

export type VeoAspectRatio = '9:16' | '16:9';
export type VeoResolution = '720p' | '1080p';
export type VeoDurationSeconds = 4 | 6 | 8;

export interface VeoProviderConfig {
  project: string;
  location: string;
  model: string;
  outputRoot: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
}

export interface VeoGenerationInput {
  prompt: string;
  imageBytes?: Uint8Array;
  imageMimeType?: 'image/png';
  aspectRatio?: VeoAspectRatio;
  resolution?: VeoResolution;
  durationSeconds?: VeoDurationSeconds;
  numberOfVideos?: number;
  generateAudio?: boolean;
}

export interface VeoOperation {
  readonly [key: string]: unknown;
}

export interface VeoGenerationResult {
  bytes: Uint8Array;
  operation: VeoOperation;
  operationName: string;
  request: Record<string, unknown>;
}

interface VeoSdkClient {
  models: {
    generateVideos(request: Record<string, unknown>): Promise<unknown>;
  };
  operations: {
    getVideosOperation(input: { operation: unknown }): Promise<unknown>;
  };
}

export class VeoProviderError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = 'VeoProviderError';
  }
}

export function resolveVeoConfig(env: NodeJS.ProcessEnv = process.env): VeoProviderConfig {
  const project = firstConfigured(env.GOOGLE_CLOUD_PROJECT_VEO, env.GOOGLE_CLOUD_PROJECT);
  if (!project) throw new VeoProviderError('veo_project_missing');
  return {
    project,
    location: firstConfigured(env.GOOGLE_CLOUD_LOCATION_VEO, env.GOOGLE_CLOUD_LOCATION) ?? DEFAULT_LOCATION,
    model: firstConfigured(env.VEO_VERTEX_MODEL) ?? DEFAULT_MODEL,
    outputRoot: firstConfigured(env.VEO_OUTPUT_ROOT) ?? 'tmp/veo',
    pollIntervalMs: boundedInteger(env.VEO_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS, 100, 120_000),
    pollTimeoutMs: boundedInteger(env.VEO_POLL_TIMEOUT_MS, DEFAULT_POLL_TIMEOUT_MS, 1_000, 3_600_000),
  };
}

export function buildVeoRequest(input: VeoGenerationInput, model: string): Record<string, unknown> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new VeoProviderError('veo_prompt_missing');
  if (input.imageBytes && input.imageBytes.byteLength === 0) throw new VeoProviderError('veo_image_empty');
  if (input.imageBytes && input.imageMimeType !== 'image/png') throw new VeoProviderError('veo_image_mime_type_invalid');
  const aspectRatio = input.aspectRatio ?? '9:16';
  const resolution = input.resolution ?? '720p';
  const durationSeconds = input.durationSeconds ?? 8;
  const numberOfVideos = input.numberOfVideos ?? 1;
  if (!['9:16', '16:9'].includes(aspectRatio)) throw new VeoProviderError('veo_aspect_ratio_invalid');
  if (!['720p', '1080p'].includes(resolution)) throw new VeoProviderError('veo_resolution_invalid');
  if (![4, 6, 8].includes(durationSeconds)) throw new VeoProviderError('veo_duration_invalid');
  if (numberOfVideos !== 1) {
    throw new VeoProviderError('veo_number_of_videos_invalid');
  }
  return {
    model,
    prompt,
    ...(input.imageBytes
      ? { image: { imageBytes: Buffer.from(input.imageBytes).toString('base64'), mimeType: 'image/png' } }
      : {}),
    config: { numberOfVideos, aspectRatio, resolution, durationSeconds, generateAudio: input.generateAudio ?? false },
  };
}

export function createVertexVeoSdk(config: Pick<VeoProviderConfig, 'project' | 'location'>): VeoSdkClient {
  return new GoogleGenAI({ vertexai: true, project: config.project, location: config.location }) as unknown as VeoSdkClient;
}

export class VertexVeoProvider {
  constructor(
    private readonly config: VeoProviderConfig,
    private readonly sdk: VeoSdkClient = createVertexVeoSdk(config),
    private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void> = delay,
  ) {}

  async generate(input: VeoGenerationInput, signal?: AbortSignal): Promise<VeoGenerationResult> {
    const request = buildVeoRequest(input, this.config.model);
    let operation = await this.sdk.models.generateVideos(request);
    const deadline = Date.now() + this.config.pollTimeoutMs;
    while (!isDone(operation)) {
      if (Date.now() >= deadline) throw new VeoProviderError('veo_generation_timeout');
      await this.sleep(this.config.pollIntervalMs, signal);
      operation = await this.sdk.operations.getVideosOperation({ operation });
    }
    if (operation.error !== undefined && operation.error !== null) throw new VeoProviderError('veo_generation_failed');
    const operationName = operationIdentifier(operation);
    const bytes = generatedVideoBytes(operation);
    if (!bytes) throw new VeoProviderError('veo_output_bytes_missing');
    return { bytes, operation, operationName, request };
  }
}

function firstConfigured(...values: readonly (string | undefined)[]): string | undefined {
  return values.map((value) => value?.trim()).find((value) => Boolean(value));
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new VeoProviderError('veo_configuration_invalid');
  return parsed;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDone(value: unknown): value is Record<string, any> {
  return isRecord(value) && value.done === true;
}

function operationIdentifier(operation: Record<string, any>): string {
  const identifier = typeof operation.name === 'string' ? operation.name : operation.id;
  if (typeof identifier !== 'string' || !identifier.trim()) throw new VeoProviderError('veo_operation_id_missing');
  return identifier;
}

function generatedVideoBytes(operation: Record<string, any>): Uint8Array | undefined {
  const video = operation.response?.generatedVideos?.[0]?.video;
  if (!isRecord(video) || typeof video.videoBytes !== 'string' || !video.videoBytes.trim()) return undefined;
  const bytes = Buffer.from(video.videoBytes, 'base64');
  return bytes.byteLength > 0 ? bytes : undefined;
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new VeoProviderError('veo_generation_aborted');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new VeoProviderError('veo_generation_aborted'));
    }, { once: true });
  });
}
