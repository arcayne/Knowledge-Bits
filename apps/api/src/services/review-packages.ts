import {
  artifactReferenceSchema,
  knowledgeBitsContentSchema,
  knowledgeBitsEvidenceSchema,
  knowledgeBitsQaSchema,
  reviewPackageVersionSchema,
  reviewReadModelSchema,
  type ArtifactReference,
  type KnowledgeBitsEvidence,
  type ReviewReadModel,
} from '@knowledge-bits/contracts';
import { calculateContentChecksum, calculatePackageChecksum } from '@knowledge-bits/pipeline';

import type {
  WorkflowArtifact,
  WorkflowRepository,
} from '../repositories/workflow-repository.js';
import {
  readArtifactStorageObject,
  type ArtifactStorageAdapter,
} from './artifacts.js';

const ADAPTER_VERSION = 'knowledge-bits.review-package.v1';
const OWNER = 'knowledge-bits-engine';
const USAGE_RIGHTS = { scope: 'internal-review' };
const REVIEW_ASSET_KINDS = ['hero', 'infographic', 'audio'] as const;

export class ReviewPackageService {
  constructor(private readonly dependencies: {
    repository: WorkflowRepository;
    storage: ArtifactStorageAdapter;
  }) {}

  async load(runId: string): Promise<ReviewReadModel> {
    const run = await this.dependencies.repository.getRun(runId);
    if (!run) throw new ReviewPackageNotFoundError('Run not found');
    const artifacts = await this.dependencies.repository.listArtifactsForSuccessfulStageJobs(run.id, run.currentRevision);
    const assets = assetStates(run.id, artifacts);
    const mediaIssues = REVIEW_ASSET_KINDS
      .filter((kind) => assets[kind].state === 'missing')
      .map((kind) => `Required review media is missing: ${kind}`);

    try {
      for (const kind of REVIEW_ASSET_KINDS) {
        const artifact = latestArtifact(artifacts, kind);
        if (artifact) await readArtifactStorageObject(this.dependencies.storage, artifact.storageKey);
      }
      const evidenceArtifact = requiredParsedArtifact(artifacts, 'collect_sources', 'evidence');
      const contentArtifact = requiredParsedArtifact(artifacts, 'create_content', 'content');
      const qaArtifact = requiredParsedArtifact(artifacts, 'check_content', 'QA');
      const contentOutput = await this.readJson(contentArtifact, 'content');
      const qaOutput = await this.readJson(qaArtifact, 'QA');
      const content = knowledgeBitsContentSchema.parse({
        schemaVersion: 'knowledge-bits.content.v1',
        target: { kind: 'nuglet.lesson.v1', payload: contentOutput },
      });
      const evidenceOutput = await this.readJson(evidenceArtifact, 'evidence');
      const evidence = normalizeEvidence(evidenceOutput, evidenceArtifact, artifacts, content.target.payload.claims);
      const qa = knowledgeBitsQaSchema.parse(qaOutput);
      const artifactInventory = artifacts.map(toArtifactReference);
      const contentChecksum = calculateContentChecksum(content.target.payload);
      const approvalIssues = [
        ...mediaIssues,
        ...qaApprovalIssues(qa, contentChecksum),
        ...assetChecksumIssues(artifacts, contentChecksum),
      ];
      const packageChecksum = calculatePackageChecksum({
        content,
        evidence,
        qa,
        assetInventory: artifactInventory,
        adapterVersion: ADAPTER_VERSION,
        locale: run.locale,
        owner: OWNER,
        usageRights: USAGE_RIGHTS,
      });
      const persisted = await this.dependencies.repository.recordPackageVersion({
        runId: run.id,
        revision: run.currentRevision,
        packageChecksum,
        adapterVersion: ADAPTER_VERSION,
        locale: run.locale,
        owner: OWNER,
        usageRights: USAGE_RIGHTS,
        content,
        evidence,
        qa,
        artifactInventory,
      });
      const packageVersion = reviewPackageVersionSchema.parse({
        id: persisted.id,
        schemaVersion: 'knowledge-bits.review-package.v1',
        packageId: persisted.runId,
        revision: persisted.revision,
        packageChecksum: persisted.packageChecksum,
        adapterVersion: persisted.adapterVersion,
        locale: persisted.locale,
        owner: persisted.owner,
        usageRights: persisted.usageRights,
        content: persisted.content,
        evidence: persisted.evidence,
        qa: persisted.qa,
        artifactInventory: persisted.artifactInventory,
      });
      const current = await this.dependencies.repository.getRun(run.id);
      if (!current) throw new ReviewPackageNotFoundError('Run not found');
      return reviewReadModelSchema.parse({
        runId: current.id,
        title: current.title,
        currentStage: current.currentStage,
        currentRevision: current.currentRevision,
        reviewStatus: current.reviewStatus,
        currentPackageChecksum: current.packageChecksum,
        decisionAllowed: current.currentStage === 'human_review'
          && current.reviewStatus === 'pending'
          && current.packageChecksum === packageVersion.packageChecksum
          && approvalIssues.length === 0,
        issues: approvalIssues,
        package: packageVersion,
        assets,
      });
    } catch (error) {
      if (error instanceof ReviewPackageNotFoundError) throw error;
      return reviewReadModelSchema.parse({
        runId: run.id,
        title: run.title,
        currentStage: run.currentStage,
        currentRevision: run.currentRevision,
        reviewStatus: run.reviewStatus,
        currentPackageChecksum: run.packageChecksum,
        decisionAllowed: false,
        issues: [assemblyErrorMessage(error)],
        package: null,
        assets,
      });
    }
  }

  async readArtifact(runId: string, artifactId: string): Promise<{ body: Uint8Array; mediaType: string }> {
    const run = await this.dependencies.repository.getRun(runId);
    if (!run?.packageChecksum) throw new ReviewPackageNotFoundError('Artifact is not in the current package');
    const packageVersion = await this.dependencies.repository.getPackageVersion(run.id, run.packageChecksum);
    if (!packageVersion?.artifactInventory.some((artifact) => artifact.artifactId === artifactId)) {
      throw new ReviewPackageNotFoundError('Artifact is not in the current package');
    }
    const artifact = await this.dependencies.repository.getArtifact(run.id, artifactId);
    if (!artifact) throw new ReviewPackageNotFoundError('Artifact is not in the current package');
    return {
      body: await readArtifactStorageObject(this.dependencies.storage, artifact.storageKey),
      mediaType: artifact.mediaType,
    };
  }

  private async readJson(artifact: WorkflowArtifact, label: string): Promise<Record<string, unknown>> {
    try {
      const body = await readArtifactStorageObject(this.dependencies.storage, artifact.storageKey);
      const parsed: unknown = JSON.parse(Buffer.from(body).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('expected an object');
      return parsed as Record<string, unknown>;
    } catch (error) {
      throw new ReviewPackageAssemblyError(`${label} artifact is unreadable: ${errorMessage(error)}`);
    }
  }
}

export class ReviewPackageNotFoundError extends Error {}
export class ReviewPackageAssemblyError extends Error {}

function requiredParsedArtifact(
  artifacts: readonly WorkflowArtifact[],
  action: string,
  label: string,
): WorkflowArtifact {
  const artifact = [...artifacts].reverse().find((candidate) => (
    candidate.kind === 'parsed_output' && candidate.action === action
  ));
  if (!artifact) throw new ReviewPackageAssemblyError(`${label} artifact is missing`);
  return artifact;
}

function latestArtifact(artifacts: readonly WorkflowArtifact[], kind: string): WorkflowArtifact | undefined {
  return [...artifacts].reverse().find((artifact) => artifact.kind === kind);
}

function assetStates(runId: string, artifacts: readonly WorkflowArtifact[]) {
  return Object.fromEntries(REVIEW_ASSET_KINDS.map((kind) => {
    const artifact = latestArtifact(artifacts, kind);
    return [kind, artifact ? {
      state: 'available' as const,
      artifactId: artifact.id,
      mediaType: artifact.mediaType,
      previewPath: `/runs/${runId}/artifacts/${artifact.id}`,
    } : {
      state: 'missing' as const,
      artifactId: null,
      mediaType: null,
      previewPath: null,
    }];
  })) as Record<typeof REVIEW_ASSET_KINDS[number], {
    state: 'available' | 'missing';
    artifactId: string | null;
    mediaType: string | null;
    previewPath: string | null;
  }>;
}

function toArtifactReference(artifact: WorkflowArtifact): ArtifactReference {
  return artifactReferenceSchema.parse({
    artifactId: artifact.id,
    kind: artifact.kind,
    mediaType: artifact.mediaType,
    checksum: artifact.checksum,
    storageKey: artifact.storageKey,
    byteSize: artifact.byteSize,
    createdAt: artifact.createdAt.toISOString(),
    provider: typeof artifact.provenance.provider === 'string' && artifact.provenance.provider.trim()
      ? artifact.provenance.provider
      : 'unknown',
    inputChecksum: artifact.inputChecksum,
  });
}

function normalizeEvidence(
  output: Record<string, unknown>,
  artifact: WorkflowArtifact,
  artifacts: readonly WorkflowArtifact[],
  claims: unknown,
): KnowledgeBitsEvidence {
  if (!Array.isArray(output.acceptedSources)
    || !Array.isArray(output.rejectedSources)
    || !Array.isArray(output.coverageGaps)) {
    throw new ReviewPackageAssemblyError('evidence artifact is unreadable: accepted, rejected, and coverage gap decisions are required');
  }
  const acceptedSources = output.acceptedSources.map((value) => {
    if (!isRecord(value)
      || typeof value.sourceId !== 'string'
      || typeof value.url !== 'string'
      || typeof value.title !== 'string'
      || typeof value.snapshotChecksum !== 'string'
      || !isRecord(value.readability)
      || !isRecord(value.credibility)) {
      throw new ReviewPackageAssemblyError('evidence artifact is unreadable: invalid source');
    }
    const snapshot = artifacts.find((candidate) => (
      candidate.kind === 'source_snapshot'
      && candidate.action === 'collect_sources'
      && candidate.provenance.sourceId === value.sourceId
      && candidate.checksum === value.snapshotChecksum
    ));
    if (!snapshot) {
      throw new ReviewPackageAssemblyError(`evidence artifact is unreadable: accepted source ${value.sourceId} has no immutable snapshot`);
    }
    return {
      sourceId: value.sourceId,
      url: value.url,
      title: value.title,
      retrievedAt: typeof value.retrievedAt === 'string' ? value.retrievedAt : artifact.createdAt.toISOString(),
      snapshot: toArtifactReference(snapshot),
      readability: value.readability,
      credibility: value.credibility,
    };
  });
  return knowledgeBitsEvidenceSchema.parse({
    schemaVersion: 'knowledge-bits.evidence.v1',
    acceptedSources,
    rejectedSources: output.rejectedSources,
    coverageGaps: output.coverageGaps,
    claims,
  });
}

function qaApprovalIssues(qa: ReturnType<typeof knowledgeBitsQaSchema.parse>, contentChecksum: string): string[] {
  return [
    ...(!qa.deterministic.passed ? ['Deterministic QA did not pass'] : []),
    ...(qa.deterministic.contentChecksum !== contentChecksum ? ['Deterministic QA content checksum does not match learner content'] : []),
    ...(qa.editorial.findings.some((finding) => finding.blocking) ? ['Editorial QA contains blocking findings'] : []),
  ];
}

function assetChecksumIssues(artifacts: readonly WorkflowArtifact[], contentChecksum: string): string[] {
  return REVIEW_ASSET_KINDS.flatMap((kind) => {
    const artifact = latestArtifact(artifacts, kind);
    return artifact && artifact.inputChecksum !== contentChecksum
      ? [`Required ${kind} input checksum does not match learner content`]
      : [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assemblyErrorMessage(error: unknown): string {
  if (error instanceof ReviewPackageAssemblyError) return error.message;
  return `Review package is unreadable: ${errorMessage(error)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : 'unknown error';
}
