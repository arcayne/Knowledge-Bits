import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

import {
  artifactReferenceSchema,
  type ArtifactCompleteRequest,
  type ArtifactPrepareRequest,
} from '@knowledge-bits/contracts';

import {
  type WorkflowArtifact,
  type WorkflowRepository,
} from '../repositories/workflow-repository.js';

const UPLOAD_EXPIRY_SECONDS = 900;

export interface ArtifactStorageAdapter {
  preparePut(input: { storageKey: string; mediaType: string; expiresInSeconds: number }): Promise<{
    uploadUrl: string;
    requiredHeaders: Record<string, string>;
  }>;
  inspect(storageKey: string): Promise<{ checksum: string; byteSize: number; mediaType: string }>;
  read(storageKey: string): Promise<Uint8Array>;
}

export class ArtifactLeaseError extends Error {}
export class ArtifactMetadataMismatchError extends Error {}
export class ArtifactStorageObjectNotFoundError extends Error {}
export class ArtifactStorageOperationError extends Error {}
export class ArtifactStorageUnavailableError extends ArtifactStorageOperationError {}

export async function readArtifactStorageObject(
  storage: ArtifactStorageAdapter,
  storageKey: string,
): Promise<Uint8Array> {
  try {
    return await storage.read(storageKey);
  } catch (error) {
    if (error instanceof ArtifactStorageObjectNotFoundError || error instanceof ArtifactStorageOperationError) {
      throw error;
    }
    throw new ArtifactStorageOperationError('Artifact storage read failed', { cause: error });
  }
}

export class UnavailableArtifactStorageAdapter implements ArtifactStorageAdapter {
  async preparePut(): Promise<never> {
    throw new ArtifactStorageUnavailableError('Artifact storage is not configured for the standalone engine');
  }

  async inspect(): Promise<never> {
    throw new ArtifactStorageUnavailableError('Artifact storage is not configured for the standalone engine');
  }

  async read(): Promise<never> {
    throw new ArtifactStorageUnavailableError('Artifact storage is not configured for the standalone engine');
  }
}

export class ArtifactService {
  constructor(
    private readonly dependencies: {
      repository: WorkflowRepository;
      storage: ArtifactStorageAdapter;
      idGenerator?: () => string;
    },
  ) {}

  async prepare(workerId: string, input: ArtifactPrepareRequest) {
    await this.requireActiveArtifactLease(workerId, input.jobId, input.runId, input.revision, input.kind);
    const artifactId = (this.dependencies.idGenerator ?? randomUUID)();
    const storageKey = artifactStorageKey(input.runId, input.revision, artifactId);
    const upload = await this.dependencies.storage.preparePut({
      storageKey,
      mediaType: input.mediaType,
      expiresInSeconds: UPLOAD_EXPIRY_SECONDS,
    });
    return { artifactId, storageKey, ...upload };
  }

  async complete(workerId: string, input: ArtifactCompleteRequest) {
    await this.requireActiveArtifactLease(workerId, input.jobId, input.runId, input.revision, input.kind);
    const storageKey = artifactStorageKey(input.runId, input.revision, input.artifactId);
    const inspected = await this.dependencies.storage.inspect(storageKey);
    if (
      inspected.checksum !== input.checksum
      || inspected.byteSize !== input.byteSize
      || inspected.mediaType !== input.mediaType
    ) {
      throw new ArtifactMetadataMismatchError('Artifact metadata does not match storage inspection');
    }
    const { action: _action, job: _job, jobId: _jobId, stage: _stage, ...workerProvenance } = input.provenance;
    const artifact = await this.dependencies.repository.recordArtifactForActiveLease({
      workerId,
      jobId: input.jobId,
      id: input.artifactId,
      runId: input.runId,
      revision: input.revision,
      kind: input.kind,
      mediaType: inspected.mediaType,
      checksum: inspected.checksum,
      storageKey,
      byteSize: inspected.byteSize,
      provenance: { ...workerProvenance, provider: input.provider },
      inputChecksum: input.inputChecksum,
    });
    return toArtifactReference(artifact, input.provider);
  }

  private async requireActiveArtifactLease(
    workerId: string,
    jobId: string,
    runId: string,
    revision: number,
    kind: string,
  ): Promise<void> {
    if (!await this.dependencies.repository.hasActiveArtifactLease({ jobId, runId, workerId, revision, kind })) {
      throw new ArtifactLeaseError('Artifact-producing job lease is no longer valid');
    }
  }
}

export function artifactStorageKey(runId: string, revision: number, artifactId: string): string {
  return `knowledge-bits/nuglet/${runId}/${revision}/${artifactId}`;
}

function toArtifactReference(artifact: WorkflowArtifact, provider: string) {
  return artifactReferenceSchema.parse({
    artifactId: artifact.id,
    kind: artifact.kind,
    mediaType: artifact.mediaType,
    checksum: artifact.checksum,
    storageKey: artifact.storageKey,
    byteSize: artifact.byteSize,
    createdAt: artifact.createdAt.toISOString(),
    provider,
    inputChecksum: artifact.inputChecksum,
  });
}

export interface LocalFilesystemArtifactStorageConfig {
  root: string;
  uploadBaseUrl: string;
}

interface UploadCapability {
  storageKey: string;
  mediaType: string;
  expiresAt: number;
  used: boolean;
}

export class ArtifactUploadCapabilityError extends Error {}
export class ArtifactUploadMediaTypeMismatchError extends Error {}
export class ArtifactStorageObjectExistsError extends Error {}

/** Stores artifact bytes and their inspected media type below a local root. */
export class LocalFilesystemArtifactStorageAdapter implements ArtifactStorageAdapter {
  private readonly root: string;
  private readonly uploadBaseUrl: string;
  private readonly capabilities = new Map<string, UploadCapability>();
  private readonly now: () => number;
  private readonly tokenGenerator: () => string;

  constructor(
    config: LocalFilesystemArtifactStorageConfig,
    dependencies: { now?: () => number; tokenGenerator?: () => string } = {},
  ) {
    if (!config.root.trim()) throw new Error('Local artifact storage root is required');
    const uploadBaseUrl = new URL(config.uploadBaseUrl);
    if (uploadBaseUrl.protocol !== 'http:' && uploadBaseUrl.protocol !== 'https:') {
      throw new Error('Local artifact upload base URL must use http or https');
    }
    this.root = resolve(config.root);
    this.uploadBaseUrl = config.uploadBaseUrl.replace(/\/$/, '');
    this.now = dependencies.now ?? Date.now;
    this.tokenGenerator = dependencies.tokenGenerator ?? randomUUID;
  }

  async preparePut(input: { storageKey: string; mediaType: string; expiresInSeconds: number }) {
    validateStorageKey(input.storageKey);
    validateMediaType(input.mediaType);
    if (!Number.isFinite(input.expiresInSeconds) || input.expiresInSeconds <= 0) {
      throw new ArtifactUploadCapabilityError('Artifact upload expiry must be positive');
    }
    const token = this.tokenGenerator();
    this.capabilities.set(token, {
      storageKey: input.storageKey,
      mediaType: input.mediaType,
      expiresAt: this.now() + input.expiresInSeconds * 1000,
      used: false,
    });
    return {
      uploadUrl: `${this.uploadBaseUrl}/artifacts/upload/${encodeURIComponent(token)}`,
      requiredHeaders: { 'content-type': input.mediaType },
    };
  }

  async upload(token: string, bytes: Uint8Array, mediaType: string): Promise<void> {
    const capability = this.capabilities.get(token);
    if (!capability || capability.used) {
      throw new ArtifactUploadCapabilityError('Artifact upload capability is invalid or expired');
    }
    if (capability.expiresAt <= this.now()) {
      this.capabilities.delete(token);
      throw new ArtifactUploadCapabilityError('Artifact upload capability is invalid or expired');
    }
    if (mediaType !== capability.mediaType) {
      throw new ArtifactUploadMediaTypeMismatchError('Artifact upload media type does not match the prepared artifact');
    }
    capability.used = true;
    const releaseClaim = () => {
      if (this.capabilities.get(token) === capability) capability.used = false;
    };

    let artifactPath: string;
    try {
      artifactPath = await this.safePath(capability.storageKey, true);
    } catch (error) {
      releaseClaim();
      throw error;
    }
    const metadataPath = `${artifactPath}.metadata.json`;
    try {
      await stat(artifactPath);
      throw new ArtifactStorageObjectExistsError('Artifact storage key already exists');
    } catch (error) {
      if (error instanceof ArtifactStorageObjectExistsError) {
        releaseClaim();
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        releaseClaim();
        throw new ArtifactStorageOperationError('Local artifact upload failed', { cause: error });
      }
    }

    const temporaryPath = `${artifactPath}.${randomUUID()}.tmp`;
    const temporaryMetadataPath = `${metadataPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, bytes, { flag: 'wx' });
      await writeFile(temporaryMetadataPath, JSON.stringify({ mediaType }), { flag: 'wx' });
      await link(temporaryPath, artifactPath);
      await link(temporaryMetadataPath, metadataPath);
    } catch (error) {
      await Promise.all([
        rm(temporaryPath, { force: true }),
        rm(temporaryMetadataPath, { force: true }),
      ]);
      releaseClaim();
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ArtifactStorageObjectExistsError('Artifact storage key already exists');
      }
      throw new ArtifactStorageOperationError('Local artifact upload failed', { cause: error });
    }
    this.capabilities.delete(token);
    await Promise.all([
      rm(temporaryPath, { force: true }),
      rm(temporaryMetadataPath, { force: true }),
    ]);
  }

  async inspect(storageKey: string) {
    const artifactPath = await this.safePath(storageKey, false);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(artifactPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ArtifactStorageObjectNotFoundError('Local artifact does not exist');
      }
      throw new ArtifactStorageOperationError('Local artifact inspection failed', { cause: error });
    }
    try {
      const metadata = JSON.parse(await readFile(`${artifactPath}.metadata.json`, 'utf8')) as { mediaType?: unknown };
      if (typeof metadata.mediaType !== 'string' || !metadata.mediaType) throw new Error('Invalid artifact metadata');
      return {
        checksum: createHash('sha256').update(bytes).digest('hex'),
        byteSize: bytes.byteLength,
        mediaType: metadata.mediaType,
      };
    } catch (error) {
      throw new ArtifactStorageOperationError('Local artifact inspection failed', { cause: error });
    }
  }

  async read(storageKey: string): Promise<Uint8Array> {
    const artifactPath = await this.safePath(storageKey, false);
    try {
      return await readFile(artifactPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ArtifactStorageObjectNotFoundError('Local artifact does not exist');
      }
      throw new ArtifactStorageOperationError('Local artifact read failed', { cause: error });
    }
  }

  private async safePath(storageKey: string, createParent: boolean): Promise<string> {
    validateStorageKey(storageKey);
    const artifactPath = resolve(this.root, storageKey);
    const pathRelativeToRoot = relative(this.root, artifactPath);
    if (pathRelativeToRoot.startsWith('..') || pathRelativeToRoot.startsWith('/') || pathRelativeToRoot.includes('\\')) {
      throw new ArtifactStorageOperationError('Artifact storage key is outside the local root');
    }
    if (createParent) {
      await mkdir(dirname(artifactPath), { recursive: true });
      await this.assertRealPathInsideRoot(dirname(artifactPath));
    } else {
      try {
        await this.assertRealPathInsideRoot(artifactPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return artifactPath;
  }

  private async assertRealPathInsideRoot(path: string): Promise<void> {
    const [rootPath, realPath] = await Promise.all([realpath(this.root), realpath(path)]);
    const pathRelativeToRoot = relative(rootPath, realPath);
    if (pathRelativeToRoot.startsWith('..') || pathRelativeToRoot.startsWith('/') || pathRelativeToRoot.includes('\\')) {
      throw new ArtifactStorageOperationError('Artifact storage path is outside the local root');
    }
  }
}

export { LocalFilesystemArtifactStorageAdapter as FilesystemArtifactStorageAdapter };

function validateStorageKey(storageKey: string): void {
  if (!storageKey || storageKey.startsWith('/') || storageKey.includes('\\') || storageKey.includes('\0')) {
    throw new ArtifactStorageOperationError('Artifact storage key is malformed');
  }
  const segments = storageKey.split('/');
  if (segments.length === 0 || segments.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) {
    throw new ArtifactStorageOperationError('Artifact storage key is malformed');
  }
}

function validateMediaType(mediaType: string): void {
  if (!mediaType || /[\r\n]/.test(mediaType)) throw new ArtifactStorageOperationError('Artifact media type is malformed');
}
