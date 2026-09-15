import {
  pipelineReadModelSchema,
  progressivePreviewDocumentSchema,
  progressivePreviewReadModelSchema,
  type PipelineReadModel,
  type ProgressivePreviewMedia,
  type ProgressivePreviewReadModel,
} from '@knowledge-bits/contracts';

import type { WorkflowArtifact, WorkflowRepository, WorkflowRun } from '../repositories/workflow-repository.js';
import {
  ArtifactStorageObjectNotFoundError,
  ArtifactStorageOperationError,
  readArtifactStorageObject,
  type ArtifactStorageAdapter,
} from './artifacts.js';
import {
  isOnOperatorDay,
  OPERATOR_TIME_ZONE,
  operatorDay,
} from './operator-time.js';
import { ReviewPackageService } from './review-packages.js';

const DOCUMENT_ACTIONS = {
  evidence: 'collect_sources',
  content: 'create_content',
  qa: 'check_content',
} as const;

const BASE_MEDIA = [
  { kind: 'hero', label: 'Hero image' },
  { kind: 'infographic', label: 'Infographic' },
  { kind: 'audio_brief', label: 'Brief audio' },
  { kind: 'audio_discussion', label: 'Discussion audio' },
] as const;

const INTERNAL_KINDS = new Set([
  'raw_response', 'execution_report', 'generation.execution.report',
  'generation.recipe.snapshot', 'generation.prompt.rendered', 'source_snapshot',
]);
const DAILY_DELIVERY_TARGET = 5;

type PreviewArtifact = WorkflowArtifact;

export class ProgressivePreviewService {
  constructor(private readonly dependencies: {
    repository: WorkflowRepository;
    storage: ArtifactStorageAdapter;
  }) {}

  async list(): Promise<PipelineReadModel> {
    const runs = classifyRuns(await this.dependencies.repository.listRuns());
    const today = operatorDay(new Date());
    const counts = {
      research: 0,
      create: 0,
      check: 0,
      produce_assets: 0,
      human_review: 0,
      deliver: 0,
      delivering: 0,
      needsHuman: 0,
      active: 0,
      completed: 0,
      rejected: 0,
      duplicates: 0,
      blocked: 0,
      retrying: 0,
    };
    const summaries = await Promise.all(runs.map(async ({ run, classification, duplicateOf }) => {
      const stage = run.stages[run.currentStage];
      const delivery = run.packageChecksum
        ? await this.dependencies.repository.getDeliveryForPackage(run.id, run.packageChecksum)
        : null;
      if (classification === 'duplicate') {
        counts.duplicates += 1;
      } else {
        counts[run.currentStage] += 1;
        if (classification === 'rejected') counts.rejected += 1;
        if (classification !== 'rejected' && stage?.state === 'needs_human') counts.needsHuman += 1;
        if (classification === 'active') counts.active += 1;
        if (classification === 'deliver') counts.delivering += 1;
        if (classification === 'completed') counts.completed += 1;
        if (classification !== 'rejected' && isBlocked(stage?.state, delivery?.state)) counts.blocked += 1;
        if (classification !== 'rejected' && (run.nextRetryAt || delivery?.nextAttemptAt)) counts.retrying += 1;
      }
      return {
        id: run.id,
        title: run.title,
        locale: run.locale,
        classification,
        duplicateOf,
        currentStage: run.currentStage,
        currentState: stage?.state ?? 'queued',
        reason: stage?.reason ?? null,
        currentRevision: run.currentRevision,
        currentAttempt: stage?.attempt ?? 0,
        nextRetryAt: run.nextRetryAt?.toISOString() ?? null,
        reviewStatus: run.reviewStatus,
        delivery: delivery ? {
          state: delivery.state,
          attempts: delivery.attempts,
          target: delivery.target,
          nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
          updatedAt: delivery.updatedAt.toISOString(),
        } : null,
        createdAt: run.createdAt.toISOString(),
        updatedAt: run.updatedAt.toISOString(),
      };
    }));
    const canonical = summaries.filter((run) => !['duplicate', 'rejected'].includes(run.classification));
    const delivered = canonical.filter((run) => (
      run.delivery?.state === 'succeeded' && isOnOperatorDay(run.delivery.updatedAt, today)
    )).length;
    const daily = {
      day: today,
      timezone: OPERATOR_TIME_ZONE,
      target: DAILY_DELIVERY_TARGET,
      started: canonical.filter((run) => isOnOperatorDay(run.createdAt, today)).length,
      readyForReview: canonical.filter((run) => (
        run.currentStage === 'human_review' && run.currentState === 'needs_human'
      )).length,
      approvedInFlight: canonical.filter((run) => (
        run.reviewStatus === 'approved'
        && run.delivery?.state !== 'succeeded'
        && run.delivery?.state !== 'superseded'
      )).length,
      delivered,
      remaining: Math.max(DAILY_DELIVERY_TARGET - delivered, 0),
    };
    return pipelineReadModelSchema.parse({ daily, counts, runs: summaries });
  }

  async load(runId: string): Promise<ProgressivePreviewReadModel> {
    const run = await this.dependencies.repository.getRun(runId);
    if (!run) throw new ProgressivePreviewNotFoundError('Run not found');
    const artifacts = await this.previewArtifacts(run);
    const documents = await this.documents(artifacts);
    const media = this.media(run, artifacts);
    const decision = await this.decision(run);

    return progressivePreviewReadModelSchema.parse({
      run: await this.summary(run),
      documents,
      media,
      decision,
    });
  }

  async readArtifact(runId: string, artifactId: string): Promise<{ body: Uint8Array; mediaType: string }> {
    const preview = await this.load(runId);
    const allowed = new Set([
      ...Object.values(preview.documents)
        .filter((document) => document.state === 'available')
        .map((document) => document.artifactId),
      ...preview.media
        .filter((media) => media.state === 'available')
        .map((media) => media.artifactId),
    ]);
    if (!allowed.has(artifactId)) {
      throw new ProgressivePreviewNotFoundError('Artifact is not in the current preview');
    }
    const artifact = await this.dependencies.repository.getArtifact(runId, artifactId);
    if (!artifact) throw new ProgressivePreviewNotFoundError('Artifact is not in the current preview');
    return {
      body: await readArtifactStorageObject(this.dependencies.storage, artifact.storageKey),
      mediaType: artifact.mediaType,
    };
  }

  private async summary(run: WorkflowRun) {
    const stage = run.stages[run.currentStage];
    return {
      id: run.id,
      title: run.title,
      locale: run.locale,
      classification: canonicalClassification(run),
      duplicateOf: null,
      currentStage: run.currentStage,
      currentState: stage?.state ?? 'queued',
      reason: stage?.reason ?? null,
      currentRevision: run.currentRevision,
      currentAttempt: stage?.attempt ?? 0,
      nextRetryAt: run.nextRetryAt?.toISOString() ?? null,
      reviewStatus: run.reviewStatus,
      delivery: null,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
    };
  }

  private async previewArtifacts(run: WorkflowRun): Promise<PreviewArtifact[]> {
    const packageVersion = run.packageChecksum
      ? await this.dependencies.repository.getPackageVersion(run.id, run.packageChecksum)
      : null;
    if (!packageVersion || packageVersion.revision !== run.currentRevision) {
      const [successful, currentAttempt] = await Promise.all([
        this.dependencies.repository.listArtifactsForSuccessfulStageJobs(run.id, run.currentRevision),
        this.dependencies.repository.listArtifacts(run.id, run.currentRevision),
      ]);
      return [...new Map([...successful, ...currentAttempt].map((artifact) => [artifact.id, artifact])).values()];
    }
    const inventoryIds = packageVersion.artifactInventory.map(({ artifactId }) => artifactId);
    const artifacts = await this.dependencies.repository.listArtifactsByIds(run.id, inventoryIds);
    const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
    return inventoryIds.flatMap((artifactId) => {
      const artifact = artifactsById.get(artifactId);
      return artifact ? [artifact] : [];
    });
  }

  private async documents(artifacts: readonly PreviewArtifact[]) {
    return Object.fromEntries(await Promise.all(Object.entries(DOCUMENT_ACTIONS).map(async ([slot, action]) => {
      const artifact = [...artifacts].reverse().find((candidate) => (
        candidate.kind === 'parsed_output' && candidate.action === action
      ));
      return [slot, await this.document(artifact)] as const;
    }))) as {
      evidence: Awaited<ReturnType<ProgressivePreviewService['document']>>;
      content: Awaited<ReturnType<ProgressivePreviewService['document']>>;
      qa: Awaited<ReturnType<ProgressivePreviewService['document']>>;
    };
  }

  private async document(artifact: PreviewArtifact | undefined) {
    if (!artifact) return progressivePreviewDocumentSchema.parse({
      state: 'missing', artifactId: null, data: null, issue: null,
    });
    try {
      const body = await readArtifactStorageObject(this.dependencies.storage, artifact.storageKey);
      const data: unknown = JSON.parse(Buffer.from(body).toString('utf8'));
      return progressivePreviewDocumentSchema.parse({
        state: 'available', artifactId: artifact.id, data, issue: null,
      });
    } catch {
      return progressivePreviewDocumentSchema.parse({
        state: 'unavailable', artifactId: artifact.id, issue: 'Preview document is unavailable',
      });
    }
  }

  private media(run: WorkflowRun, artifacts: readonly PreviewArtifact[]) {
    const planned = plannedLegacyMedia(run);
    const latestByKind = new Map<string, PreviewArtifact>();
    for (const artifact of artifacts) {
      if (INTERNAL_KINDS.has(artifact.kind) || !isLearnerFacingMedia(artifact.mediaType)) continue;
      latestByKind.set(artifact.kind, artifact);
    }
    const media: ProgressivePreviewMedia[] = [];
    for (const { kind, label } of BASE_MEDIA) {
      const artifact = latestByKind.get(kind);
      if (artifact) {
        media.push(availableMedia(run.id, artifact, label));
        continue;
      }
      const plannedArtifact = planned.get(kind);
      if (plannedArtifact) {
        media.push(plannedMedia(kind, label, plannedArtifact));
        continue;
      }
      media.push(missingMedia(kind, label));
    }
    for (const [kind, artifact] of latestByKind) {
      if (BASE_MEDIA.some((base) => base.kind === kind)) continue;
      media.push(availableMedia(run.id, artifact, labelForKind(kind)));
    }
    return media;
  }

  private async decision(run: WorkflowRun) {
    const stage = run.stages[run.currentStage];
    if (run.currentStage !== 'human_review' || stage?.state !== 'needs_human' || run.reviewStatus !== 'pending') {
      return { allowed: false, issues: [], packageChecksum: run.packageChecksum };
    }
    const review = await new ReviewPackageService({
      repository: this.dependencies.repository,
      storage: publicReviewStorage(this.dependencies.storage),
    }).load(run.id);
    return {
      allowed: review.decisionAllowed,
      issues: review.issues,
      packageChecksum: review.package?.packageChecksum ?? null,
    };
  }
}

function isBlocked(stageState: string | undefined, deliveryState: string | undefined): boolean {
  return stageState === 'waiting'
    || stageState === 'needs_human'
    || deliveryState === 'waiting'
    || deliveryState === 'failed'
    || deliveryState === 'needs_human'
    || deliveryState === 'superseded';
}

type PipelineClassification = 'active' | 'deliver' | 'completed' | 'rejected' | 'duplicate';

interface ClassifiedRun {
  run: WorkflowRun;
  classification: PipelineClassification;
  duplicateOf: string | null;
}

function classifyRuns(runs: readonly WorkflowRun[]): ClassifiedRun[] {
  const currentByIdentity = new Map<string, WorkflowRun>();
  for (const run of runs) {
    const identity = pipelineIdentity(run);
    const current = currentByIdentity.get(identity);
    if (!current || run.updatedAt > current.updatedAt || (
      run.updatedAt.getTime() === current.updatedAt.getTime() && run.id < current.id
    )) {
      currentByIdentity.set(identity, run);
    }
  }
  const canonicalIds = new Set([...currentByIdentity.values()].map((run) => run.id));
  const classified = runs.map((run) => {
    const canonical = currentByIdentity.get(pipelineIdentity(run));
    if (!canonical || canonical.id === run.id) {
      return {
        run,
        classification: canonicalClassification(run),
        duplicateOf: null,
      } satisfies ClassifiedRun;
    }
    return {
      run,
      classification: 'duplicate' as const,
      duplicateOf: canonical.id,
    } satisfies ClassifiedRun;
  });
  return classified.sort((left, right) => {
    const leftCanonical = canonicalIds.has(left.run.id) ? 0 : 1;
    const rightCanonical = canonicalIds.has(right.run.id) ? 0 : 1;
    return leftCanonical - rightCanonical
      || right.run.updatedAt.getTime() - left.run.updatedAt.getTime()
      || left.run.id.localeCompare(right.run.id);
  });
}

function canonicalClassification(run: WorkflowRun): Exclude<PipelineClassification, 'duplicate'> {
  if (run.reviewStatus === 'rejected') return 'rejected';
  if (run.currentStage === 'deliver') {
    return run.stages.deliver?.state === 'done' ? 'completed' : 'deliver';
  }
  return 'active';
}

function pipelineIdentity(run: WorkflowRun): string {
  const baseline = run.brief.baseline;
  if (isRecord(baseline) && typeof baseline.runId === 'string' && baseline.runId.length > 0) {
    return `baseline:${baseline.runId}`;
  }
  if (run.notebookLmNotebookId) return `notebooklm:${run.notebookLmNotebookId}`;
  return `run:${run.id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ProgressivePreviewNotFoundError extends Error {}

function publicReviewStorage(storage: ArtifactStorageAdapter): ArtifactStorageAdapter {
  return {
    preparePut: (input) => storage.preparePut(input),
    inspect: (storageKey) => storage.inspect(storageKey),
    async read(storageKey) {
      try {
        return await storage.read(storageKey);
      } catch (error) {
        if (error instanceof ArtifactStorageObjectNotFoundError) {
          throw new ArtifactStorageObjectNotFoundError('Artifact is unavailable');
        }
        throw new ArtifactStorageOperationError('Artifact storage is unavailable');
      }
    },
  };
}

function isLearnerFacingMedia(mediaType: string): boolean {
  return mediaType.startsWith('image/') || mediaType.startsWith('audio/') || mediaType.startsWith('video/');
}

function availableMedia(runId: string, artifact: PreviewArtifact, label: string) {
  return {
    state: 'available' as const,
    artifactId: artifact.id,
    kind: artifact.kind,
    label,
    mediaType: artifact.mediaType,
    previewPath: `/runs/${runId}/artifacts/${artifact.id}`,
    issue: null,
  };
}

function missingMedia(kind: string, label: string) {
  return {
    state: 'missing' as const,
    artifactId: null,
    kind,
    label,
    mediaType: null,
    previewPath: null,
    issue: null,
  };
}

function plannedMedia(kind: string, label: string, artifact: { mediaType: string; checksum: string; byteSize: number }) {
  return {
    state: 'planned' as const,
    artifactId: null,
    kind,
    label,
    mediaType: artifact.mediaType,
    previewPath: null,
    issue: null,
    checksum: artifact.checksum,
    byteSize: artifact.byteSize,
  };
}

function plannedLegacyMedia(run: WorkflowRun): Map<string, { mediaType: string; checksum: string; byteSize: number }> {
  const generationPlan = isRecord(run.brief.generationPlan) ? run.brief.generationPlan : null;
  const reuse = generationPlan && isRecord(generationPlan.legacyMediaReuse) ? generationPlan.legacyMediaReuse : null;
  const artifacts = reuse && isRecord(reuse.artifacts) ? reuse.artifacts : null;
  if (!artifacts) return new Map();
  const roles = { hero: 'hero', infographic: 'infographic', audio_brief: 'audioBrief', audio_discussion: 'audioDiscussion' } as const;
  const planned = new Map<string, { mediaType: string; checksum: string; byteSize: number }>();
  for (const [kind, role] of Object.entries(roles)) {
    const value = artifacts[role];
    if (!isRecord(value) || typeof value.mediaType !== 'string' || typeof value.checksum !== 'string' || typeof value.byteSize !== 'number') continue;
    planned.set(kind, { mediaType: value.mediaType, checksum: value.checksum, byteSize: value.byteSize });
  }
  return planned;
}

function labelForKind(kind: string): string {
  return kind.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}
