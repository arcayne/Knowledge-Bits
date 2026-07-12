import { randomUUID } from 'node:crypto';

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
}

export class ArtifactLeaseError extends Error {}
export class ArtifactMetadataMismatchError extends Error {}
export class ArtifactStorageObjectNotFoundError extends Error {}
export class ArtifactStorageOperationError extends Error {}
export class ArtifactStorageUnavailableError extends ArtifactStorageOperationError {}

export class UnavailableArtifactStorageAdapter implements ArtifactStorageAdapter {
  async preparePut(): Promise<never> {
    throw new ArtifactStorageUnavailableError('Artifact storage is not configured for the standalone engine');
  }

  async inspect(): Promise<never> {
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
    await this.requireActiveArtifactLease(workerId, input.jobId, input.runId, input.revision);
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
    await this.requireActiveArtifactLease(workerId, input.jobId, input.runId, input.revision);
    const storageKey = artifactStorageKey(input.runId, input.revision, input.artifactId);
    const inspected = await this.dependencies.storage.inspect(storageKey);
    if (
      inspected.checksum !== input.checksum
      || inspected.byteSize !== input.byteSize
      || inspected.mediaType !== input.mediaType
    ) {
      throw new ArtifactMetadataMismatchError('Artifact metadata does not match storage inspection');
    }
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
      provenance: input.provenance,
      inputChecksum: input.inputChecksum,
    });
    return toArtifactReference(artifact, input.provider);
  }

  private async requireActiveArtifactLease(
    workerId: string,
    jobId: string,
    runId: string,
    revision: number,
  ): Promise<void> {
    if (!await this.dependencies.repository.hasActiveArtifactLease({ jobId, runId, workerId, revision })) {
      throw new ArtifactLeaseError('Artifact-producing job lease is no longer valid');
    }
  }
}

export function artifactStorageKey(runId: string, revision: number, artifactId: string): string {
  return `knowledge-bits/${runId}/${revision}/${artifactId}`;
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
