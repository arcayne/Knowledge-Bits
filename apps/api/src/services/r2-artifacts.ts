import { createHash } from 'node:crypto';

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import {
  ArtifactStorageObjectNotFoundError,
  ArtifactStorageOperationError,
  type ArtifactStorageAdapter,
  UnavailableArtifactStorageAdapter,
} from './artifacts.js';

const DEFAULT_BUCKET = 'nuglet-media-prod';
const DEFAULT_PUBLIC_BASE_URL = 'https://media.nuglet.app';

type R2Client = Pick<S3Client, 'send'>;
type PresignPut = (client: S3Client, command: PutObjectCommand, options: { expiresIn: number }) => Promise<string>;

export interface R2ArtifactStorageConfig {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
}

export class R2ArtifactStorageAdapter implements ArtifactStorageAdapter {
  private readonly client: R2Client;
  private readonly presignPut: PresignPut;

  constructor(
    private readonly config: R2ArtifactStorageConfig,
    dependencies: { client?: R2Client; presignPut?: PresignPut } = {},
  ) {
    this.client = dependencies.client ?? new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    this.presignPut = dependencies.presignPut ?? ((client, command, options) => getSignedUrl(client, command, options));
  }

  async preparePut(input: { storageKey: string; mediaType: string; expiresInSeconds: number }) {
    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: input.storageKey,
      ContentType: input.mediaType,
    });
    try {
      const uploadUrl = await this.presignPut(this.client as S3Client, command, {
        expiresIn: input.expiresInSeconds,
      });
      return {
        uploadUrl,
        requiredHeaders: { 'content-type': input.mediaType },
      };
    } catch (error) {
      throwStorageError('R2 upload preparation failed', error);
    }
  }

  async inspect(storageKey: string) {
    let response: GetObjectCommandOutput;
    try {
      response = await this.client.send(new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: storageKey,
      })) as GetObjectCommandOutput;
    } catch (error) {
      throwStorageError('R2 artifact inspection failed', error);
    }

    try {
      const bytes = await bodyToBytes(response.Body);
      return {
        checksum: createHash('sha256').update(bytes).digest('hex'),
        byteSize: bytes.byteLength,
        mediaType: response.ContentType ?? 'application/octet-stream',
      };
    } catch (error) {
      throwStorageError('R2 artifact inspection failed', error);
    }
  }

  async read(storageKey: string): Promise<Uint8Array> {
    let response: GetObjectCommandOutput;
    try {
      response = await this.client.send(new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: storageKey,
      })) as GetObjectCommandOutput;
    } catch (error) {
      throwStorageError('R2 artifact read failed', error);
    }
    try {
      return await bodyToBytes(response.Body);
    } catch (error) {
      throwStorageError('R2 artifact read failed', error);
    }
  }
}

export function createArtifactStorageFromEnv(env: NodeJS.ProcessEnv): ArtifactStorageAdapter {
  const mode = env.ARTIFACT_STORAGE_MODE ?? 'unavailable';
  if (mode !== 'r2') return new UnavailableArtifactStorageAdapter();

  const config = {
    accountId: env.ARTIFACT_STORAGE_R2_ACCOUNT_ID,
    bucket: env.ARTIFACT_STORAGE_R2_BUCKET ?? DEFAULT_BUCKET,
    accessKeyId: env.ARTIFACT_STORAGE_R2_ACCESS_KEY_ID,
    secretAccessKey: env.ARTIFACT_STORAGE_R2_SECRET_ACCESS_KEY,
    publicBaseUrl: env.ARTIFACT_STORAGE_PUBLIC_BASE_URL ?? DEFAULT_PUBLIC_BASE_URL,
  };
  const missing = Object.entries(config)
    .filter(([key, value]) => key !== 'publicBaseUrl' && !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`ARTIFACT_STORAGE_MODE=r2 requires: ${missing.join(', ')}`);
  }
  return new R2ArtifactStorageAdapter(config as R2ArtifactStorageConfig);
}

async function bodyToBytes(body: GetObjectCommandOutput['Body']): Promise<Uint8Array> {
  if (!body) throw new Error('R2 response did not include an object body');
  if ('transformToByteArray' in body && typeof body.transformToByteArray === 'function') {
    return body.transformToByteArray();
  }
  if (body instanceof Uint8Array) return body;
  if (typeof body === 'object' && Symbol.asyncIterator in body) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new Error('R2 response body cannot be read');
}

function throwStorageError(message: string, error: unknown): never {
  if (isNotFoundError(error)) throw new ArtifactStorageObjectNotFoundError(`${message}: object does not exist`);
  if (error instanceof ArtifactStorageOperationError) throw error;
  throw new ArtifactStorageOperationError(message, { cause: error });
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.$metadata?.httpStatusCode === 404
    || candidate.name === 'NoSuchKey'
    || candidate.name === 'NotFound'
    || candidate.name === 'NoSuchBucket';
}
