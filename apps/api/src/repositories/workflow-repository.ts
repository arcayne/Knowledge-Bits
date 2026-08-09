import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type {
  ArtifactReference,
  JobClaim,
  JobResult,
  KnowledgeBitsContent,
  KnowledgeBitsEvidence,
  KnowledgeBitsQa,
  NugletGenerationPlan,
  ReviewDecision,
  ReviewStatus,
  StageState,
  WorkflowStage,
} from '@knowledge-bits/contracts';
import { knowledgeBitsRunBriefSchema, nugletGenerationPlanSchema } from '@knowledge-bits/contracts';
import {
  calculatePackageChecksum,
  nextTransition,
  WorkflowTransitionError,
  type JsonValue,
  type TransitionResult,
} from '@knowledge-bits/pipeline';
import { Prisma, PrismaClient } from '@prisma/client';

type JsonObject = Record<string, unknown>;

const WORKFLOW_STAGES: readonly WorkflowStage[] = [
  'research', 'create', 'check', 'produce_assets', 'human_review', 'deliver',
];
const BOOTSTRAP_STAGES = WORKFLOW_STAGES.filter((stage) => stage !== 'human_review');

const ACTION_BY_STAGE: Readonly<Record<Exclude<WorkflowStage, 'human_review'>, string>> = {
  research: 'collect_sources',
  create: 'create_content',
  check: 'check_content',
  produce_assets: 'produce_assets',
  deliver: 'deliver_package',
};
const AUDIT_ARTIFACT_KINDS = new Set([
  'raw_response',
  'parsed_output',
  'execution_report',
  'generation.recipe.snapshot',
  'generation.prompt.rendered',
  'generation.execution.report',
]);
const REVIEW_MEDIA_ARTIFACT_KINDS = new Set([
  'hero',
  'infographic',
  'audio_brief',
  'audio_discussion',
  'public_preview',
]);

export interface WorkflowRun {
  id: string;
  title: string;
  locale: string;
  brief: JsonObject;
  notebookLmNotebookId?: string;
  currentStage: WorkflowStage;
  currentRevision: number;
  packageChecksum: string | null;
  approvedChecksum: string | null;
  reviewStatus: ReviewStatus;
  stages: Partial<Record<WorkflowStage, WorkflowStageSnapshot>>;
  nextRetryAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowStageSnapshot {
  name: WorkflowStage;
  state: StageState;
  reason: string | null;
  attempt: number;
  revisionAttempts: number;
}

export interface WorkflowJob {
  id: string;
  runId: string;
  stage: WorkflowStage;
  action: string;
  state: StageState | 'superseded';
  idempotencyKey: string;
  availableAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  executionDeadlineAt: Date | null;
  attempt: number;
  input: JsonObject;
  result: JobResult | null;
  completionReceipt: CompletionReceipt | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowArtifact {
  id: string;
  runId: string;
  revision: number;
  kind: string;
  mediaType: string;
  checksum: string;
  storageKey: string;
  byteSize: number;
  provenance: JsonObject;
  inputChecksum: string | null;
  jobId: string | null;
  stage: WorkflowStage | null;
  action: string | null;
  createdAt: Date;
}

export interface WorkflowReview {
  id: string;
  runId: string;
  revision: number;
  packageChecksum: string;
  decision: string;
  reviewerId: string;
  comment: string | null;
  createdAt: Date;
}

export interface WorkflowDelivery {
  id: string;
  runId: string;
  packageVersionId: string;
  target: string;
  packageChecksum: string;
  idempotencyKey: string;
  state: string;
  attempts: number;
  response: JsonObject | null;
  nextAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowPackageVersion {
  id: string;
  runId: string;
  revision: number;
  packageChecksum: string;
  adapterVersion: string;
  locale: string;
  owner: string;
  usageRights: JsonObject;
  content: KnowledgeBitsContent;
  evidence: KnowledgeBitsEvidence;
  qa: KnowledgeBitsQa;
  artifactInventory: ArtifactReference[];
  createdAt: Date;
}

export interface CreateRunInput {
  id?: string;
  title: string;
  locale: string;
  brief: JsonObject;
  notebookLmNotebookId?: string;
  currentStage?: WorkflowStage;
  currentRevision?: number;
  packageChecksum?: string | null;
  approvedChecksum?: string | null;
  reviewStatus?: ReviewStatus;
  stages?: Array<{
    name: WorkflowStage;
    state: StageState;
    reason?: string | null;
    attempt?: number;
  }>;
}

export interface QueueJobInput {
  id?: string;
  runId: string;
  stage: WorkflowStage;
  action: string;
  idempotencyKey: string;
  input: JsonObject;
  availableAt?: Date;
}

export interface ClaimJobInput {
  workerId: string;
  capabilities?: string[];
  leaseSeconds: number;
  preferredRunId?: string;
  executionSeconds?: number;
  now?: Date;
}

const DEFAULT_JOB_EXECUTION_SECONDS = 300;
const CREATE_CONTENT_JOB_EXECUTION_SECONDS = 420;
const PRODUCE_ASSETS_JOB_EXECUTION_SECONDS = 1_200;

function stageCompletionRank(stage: WorkflowStage): number {
  switch (stage) {
    case 'deliver': return 5;
    case 'produce_assets': return 4;
    case 'check': return 3;
    case 'create': return 2;
    case 'research': return 1;
    case 'human_review': return 0;
  }
}

export interface RenewJobLeaseInput {
  jobId: string;
  workerId: string;
}

export interface CompleteJobInput {
  workerId: string;
  result: JobResult;
}

export interface HasActiveJobLeaseInput {
  jobId: string;
  runId: string;
  workerId: string;
  now?: Date;
}

export interface HasActiveArtifactLeaseInput extends HasActiveJobLeaseInput {
  revision: number;
  kind: string;
}

export interface BootstrapRunInput {
  id?: string;
  title: string;
  locale: string;
  brief: JsonObject;
  notebookLmNotebookId?: string;
}

export interface WorkflowJobContext {
  job: WorkflowJob;
  run: WorkflowRun;
  stage: WorkflowStageSnapshot;
  packageChecksum: string | null;
  approvedChecksum: string | null;
}

export interface ApplyJobResultInput extends CompleteJobInput {
  transition?: TransitionResult;
  retryAt?: Date;
}

export interface RecordArtifactInput {
  id?: string;
  runId: string;
  revision: number;
  kind: string;
  mediaType: string;
  checksum: string;
  storageKey: string;
  byteSize: number;
  provenance: JsonObject;
  inputChecksum: string | null;
  jobId?: string | null;
  stage?: WorkflowStage | null;
  action?: string | null;
}

export interface RecordArtifactForActiveLeaseInput extends RecordArtifactInput {
  jobId: string;
  workerId: string;
}

export interface RecordReviewInput {
  id?: string;
  runId: string;
  revision: number;
  packageChecksum: string;
  decision: string;
  reviewerId: string;
  comment: string | null;
}

export interface ReviewRunInput {
  runId: string;
  packageChecksum: string;
  decision: ReviewDecision;
  reviewerId: string;
  comment?: string;
}

export interface RecordPackageChangeInput {
  runId: string;
  packageChecksum: string;
}

export interface RecordPackageVersionInput {
  id?: string;
  runId: string;
  revision: number;
  packageChecksum: string;
  adapterVersion: string;
  locale: string;
  owner: string;
  usageRights: JsonObject;
  content: KnowledgeBitsContent;
  evidence: KnowledgeBitsEvidence;
  qa: KnowledgeBitsQa;
  artifactInventory: ArtifactReference[];
}

export interface RecordDeliveryInput {
  id?: string;
  runId: string;
  packageVersionId: string;
  target: string;
  packageChecksum: string;
  idempotencyKey: string;
  state: string;
  response?: JsonObject | null;
  nextAttemptAt?: Date | null;
}

export interface TransitionDeliveryInput {
  id: string;
  jobId: string;
  workerId: string;
  packageVersionId: string;
  packageChecksum: string;
  expectedState: string;
  state: string;
  response?: JsonObject | null;
  nextAttemptAt?: Date | null;
  incrementAttempts?: boolean;
  now?: Date;
}

export interface RetryDeliveryResult {
  delivery: WorkflowDelivery;
  nextAttempt: number;
}

export interface RetryStageInput {
  runId: string;
  stage: Exclude<WorkflowStage, 'human_review' | 'deliver'>;
}

export interface RefreshResearchInput {
  runId: string;
  brief: JsonObject;
  operatorId: string;
}

type RegenerableMediaKind = 'hero' | 'infographic' | 'audio_brief' | 'audio_discussion' | 'public_preview';
type MediaRecipeOverrides = {
  infographic?: NugletGenerationPlan['recipes']['infographic'];
  heroMode?: 'deferred' | 'generate';
};

export interface PrepareLegacyRevisionInput {
  runId: string;
  expectedRevision: number;
  expectedPackageChecksum: string;
  notebookLmNotebookId: string;
  brief: JsonObject;
  comment: string;
  operatorId: string;
}

export interface PrepareLegacyRevisionResult {
  run: WorkflowRun;
  previousRevision: number;
  previousPackageChecksum: string;
}

export interface WorkflowStore {
  createRun(input: CreateRunInput): Promise<WorkflowRun>;
  bootstrapRun(input: BootstrapRunInput): Promise<WorkflowRun>;
  getRun(id: string): Promise<WorkflowRun | null>;
  listRuns(): Promise<WorkflowRun[]>;
  listArtifacts(runId: string, revision: number): Promise<WorkflowArtifact[]>;
  listArtifactsByIds(runId: string, artifactIds: readonly string[]): Promise<WorkflowArtifact[]>;
  listArtifactsForSuccessfulStageJobs(runId: string, revision: number): Promise<WorkflowArtifact[]>;
  getArtifact(runId: string, artifactId: string): Promise<WorkflowArtifact | null>;
  getReview(runId: string, packageChecksum: string): Promise<WorkflowReview | null>;
  getPackageVersion(runId: string, packageChecksum: string): Promise<WorkflowPackageVersion | null>;
  getPackageVersionById(id: string): Promise<WorkflowPackageVersion | null>;
  getDelivery(id: string): Promise<WorkflowDelivery | null>;
  getDeliveryForPackage(runId: string, packageChecksum: string): Promise<WorkflowDelivery | null>;
  getJobContext(jobId: string): Promise<WorkflowJobContext | null>;
  queueJob(input: QueueJobInput): Promise<WorkflowJob>;
  claimJob(input: ClaimJobInput): Promise<JobClaim | null>;
  renewJobLease(input: RenewJobLeaseInput): Promise<void>;
  hasActiveJobLease(input: HasActiveJobLeaseInput): Promise<boolean>;
  hasActiveArtifactLease(input: HasActiveArtifactLeaseInput): Promise<boolean>;
  completeJob(input: CompleteJobInput): Promise<JobResult>;
  applyJobResult(input: ApplyJobResultInput): Promise<WorkflowRun>;
  releaseExpiredLeases(input?: { now?: Date }): Promise<number>;
  recordArtifact(input: RecordArtifactInput): Promise<WorkflowArtifact>;
  recordArtifactForActiveLease(input: RecordArtifactForActiveLeaseInput): Promise<WorkflowArtifact>;
  recordReview(input: RecordReviewInput): Promise<WorkflowReview>;
  recordDelivery(input: RecordDeliveryInput): Promise<WorkflowDelivery>;
  transitionDeliveryForActiveLease(input: TransitionDeliveryInput): Promise<WorkflowDelivery>;
  retryDelivery(deliveryId: string): Promise<RetryDeliveryResult>;
  retryStage(input: RetryStageInput): Promise<WorkflowRun>;
  refreshResearch(input: RefreshResearchInput): Promise<WorkflowRun>;
  queueLegacyAudioReconciliation(runId: string): Promise<WorkflowRun>;
  queueMediaRegeneration(
    runId: string,
    kinds: readonly RegenerableMediaKind[],
    recipeOverrides?: MediaRecipeOverrides,
  ): Promise<WorkflowRun>;
  prepareLegacyRevision(input: PrepareLegacyRevisionInput): Promise<PrepareLegacyRevisionResult>;
  reviewRun(input: ReviewRunInput): Promise<WorkflowRun>;
  recordPackageChange(input: RecordPackageChangeInput): Promise<WorkflowRun>;
  recordPackageVersion(input: RecordPackageVersionInput): Promise<WorkflowPackageVersion>;
}

export class WorkflowConflictError extends Error {}
export class WorkflowValidationError extends Error {}
export class WorkflowNotFoundError extends Error {}

export class WorkflowRepository implements WorkflowStore {
  constructor(private readonly store: WorkflowStore) {}

  createRun(input: CreateRunInput): Promise<WorkflowRun> {
    return this.store.createRun(input);
  }

  bootstrapRun(input: BootstrapRunInput): Promise<WorkflowRun> {
    return this.store.bootstrapRun(input);
  }

  getRun(id: string): Promise<WorkflowRun | null> {
    return this.store.getRun(id);
  }

  listRuns(): Promise<WorkflowRun[]> {
    return this.store.listRuns();
  }

  listArtifacts(runId: string, revision: number): Promise<WorkflowArtifact[]> {
    return this.store.listArtifacts(runId, revision);
  }

  listArtifactsByIds(runId: string, artifactIds: readonly string[]): Promise<WorkflowArtifact[]> {
    return this.store.listArtifactsByIds(runId, artifactIds);
  }

  listArtifactsForSuccessfulStageJobs(runId: string, revision: number): Promise<WorkflowArtifact[]> {
    return this.store.listArtifactsForSuccessfulStageJobs(runId, revision);
  }

  getArtifact(runId: string, artifactId: string): Promise<WorkflowArtifact | null> {
    return this.store.getArtifact(runId, artifactId);
  }

  getReview(runId: string, packageChecksum: string): Promise<WorkflowReview | null> {
    return this.store.getReview(runId, packageChecksum);
  }

  getPackageVersion(runId: string, packageChecksum: string): Promise<WorkflowPackageVersion | null> {
    return this.store.getPackageVersion(runId, packageChecksum);
  }

  getPackageVersionById(id: string): Promise<WorkflowPackageVersion | null> {
    return this.store.getPackageVersionById(id);
  }

  getDelivery(id: string): Promise<WorkflowDelivery | null> {
    return this.store.getDelivery(id);
  }

  getDeliveryForPackage(runId: string, packageChecksum: string): Promise<WorkflowDelivery | null> {
    return this.store.getDeliveryForPackage(runId, packageChecksum);
  }

  getJobContext(jobId: string): Promise<WorkflowJobContext | null> {
    return this.store.getJobContext(jobId);
  }

  queueJob(input: QueueJobInput): Promise<WorkflowJob> {
    return this.store.queueJob(input);
  }

  claimJob(input: ClaimJobInput): Promise<JobClaim | null> {
    return this.store.claimJob(input);
  }

  renewJobLease(input: RenewJobLeaseInput): Promise<void> {
    return this.store.renewJobLease(input);
  }

  hasActiveJobLease(input: HasActiveJobLeaseInput): Promise<boolean> {
    return this.store.hasActiveJobLease(input);
  }

  hasActiveArtifactLease(input: HasActiveArtifactLeaseInput): Promise<boolean> {
    return this.store.hasActiveArtifactLease(input);
  }

  completeJob(input: CompleteJobInput): Promise<JobResult> {
    return this.store.completeJob(input);
  }

  applyJobResult(input: ApplyJobResultInput): Promise<WorkflowRun> {
    return this.store.applyJobResult(input);
  }

  releaseExpiredLeases(input?: { now?: Date }): Promise<number> {
    return this.store.releaseExpiredLeases(input);
  }

  recordArtifact(input: RecordArtifactInput): Promise<WorkflowArtifact> {
    return this.store.recordArtifact(input);
  }

  recordArtifactForActiveLease(input: RecordArtifactForActiveLeaseInput): Promise<WorkflowArtifact> {
    return this.store.recordArtifactForActiveLease(input);
  }

  recordReview(input: RecordReviewInput): Promise<WorkflowReview> {
    return this.store.recordReview(input);
  }

  recordDelivery(input: RecordDeliveryInput): Promise<WorkflowDelivery> {
    return this.store.recordDelivery(input);
  }

  transitionDeliveryForActiveLease(input: TransitionDeliveryInput): Promise<WorkflowDelivery> {
    return this.store.transitionDeliveryForActiveLease(input);
  }

  retryDelivery(deliveryId: string): Promise<RetryDeliveryResult> {
    return this.store.retryDelivery(deliveryId);
  }

  retryStage(input: RetryStageInput): Promise<WorkflowRun> {
    return this.store.retryStage(input);
  }

  refreshResearch(input: RefreshResearchInput): Promise<WorkflowRun> {
    return this.store.refreshResearch(input);
  }

  queueLegacyAudioReconciliation(runId: string): Promise<WorkflowRun> {
    return this.store.queueLegacyAudioReconciliation(runId);
  }

  queueMediaRegeneration(
    runId: string,
    kinds: readonly RegenerableMediaKind[],
    recipeOverrides?: MediaRecipeOverrides,
  ): Promise<WorkflowRun> {
    return this.store.queueMediaRegeneration(runId, kinds, recipeOverrides);
  }

  prepareLegacyRevision(input: PrepareLegacyRevisionInput): Promise<PrepareLegacyRevisionResult> {
    return this.store.prepareLegacyRevision(input);
  }

  reviewRun(input: ReviewRunInput): Promise<WorkflowRun> {
    return this.store.reviewRun(input);
  }

  recordPackageChange(input: RecordPackageChangeInput): Promise<WorkflowRun> {
    return this.store.recordPackageChange(input);
  }

  recordPackageVersion(input: RecordPackageVersionInput): Promise<WorkflowPackageVersion> {
    return this.store.recordPackageVersion(input);
  }
}

export function createWorkflowRepository(prisma: PrismaClient): WorkflowRepository {
  return new WorkflowRepository(new PrismaWorkflowStore(prisma));
}

interface ClaimedJobRow {
  id: string;
  runId: string;
  stage: string;
  attempt: number;
  leaseExpiresAt: Date;
  executionDeadlineAt: Date;
  revision: number;
  input: Prisma.JsonValue;
}

export class PrismaWorkflowStore implements WorkflowStore {
  constructor(private readonly prisma: PrismaClient) {}

  async createRun(input: CreateRunInput): Promise<WorkflowRun> {
    const currentStage = input.currentStage ?? 'research';
    const stages = input.stages ?? [{ name: currentStage, state: 'queued' as const }];
    const run = await this.prisma.run.create({
      data: {
        id: input.id,
        title: input.title,
        locale: input.locale,
        brief: toPrismaJson(input.brief),
        notebookLmNotebookId: input.notebookLmNotebookId,
          currentStage,
          currentRevision: input.currentRevision ?? 1,
          packageChecksum: input.packageChecksum,
          approvedChecksum: input.approvedChecksum,
          reviewStatus: input.reviewStatus ?? 'pending',
        stages: {
          create: stages.map((stage) => ({
            name: stage.name,
            state: stage.state,
            reason: stage.reason,
            attempt: stage.attempt ?? 0,
            revisionAttempt: 0,
          })),
        },
      },
      include: { stages: true },
    });

    return toWorkflowRun(run);
  }

  async bootstrapRun(input: BootstrapRunInput): Promise<WorkflowRun> {
    return this.prisma.$transaction(async (transaction) => {
      if (input.notebookLmNotebookId) {
        const existing = await transaction.run.findUnique({
          where: { notebookLmNotebookId: input.notebookLmNotebookId },
          select: { id: true },
        });
        if (existing && existing.id !== input.id) {
          throw new WorkflowConflictError(`NotebookLM notebook ${input.notebookLmNotebookId} is already assigned to run ${existing.id}`);
        }
      }
      const run = await transaction.run.create({
        data: {
          id: input.id,
          title: input.title,
          locale: input.locale,
          brief: toPrismaJson(input.brief),
          notebookLmNotebookId: input.notebookLmNotebookId,
          currentStage: 'research',
          reviewStatus: 'pending',
          stages: {
            create: BOOTSTRAP_STAGES.map((name) => ({ name, state: 'queued' })),
          },
        },
        include: { stages: true },
      });
      await transaction.job.create({
        data: {
          runId: run.id,
          stage: 'research',
          action: ACTION_BY_STAGE.research,
          state: 'queued',
          idempotencyKey: initialJobIdempotencyKey(run.id),
          input: toPrismaJson({
            brief: input.brief,
            ...(input.notebookLmNotebookId ? { notebookLmNotebookId: input.notebookLmNotebookId } : {}),
          }),
        },
      });
      return toWorkflowRun(run);
    });
  }

  async getRun(id: string): Promise<WorkflowRun | null> {
    const run = await this.prisma.run.findUnique({
      where: { id },
      include: {
        stages: true,
        jobs: { where: { state: 'queued' }, orderBy: { availableAt: 'asc' }, take: 1 },
      },
    });
    return run ? toWorkflowRun(run) : null;
  }

  async listRuns(): Promise<WorkflowRun[]> {
    const runs = await this.prisma.run.findMany({
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      include: {
        stages: true,
        jobs: { where: { state: 'queued' }, orderBy: { availableAt: 'asc' }, take: 1 },
      },
    });
    return runs.map(toWorkflowRun);
  }

  async listArtifacts(runId: string, revision: number): Promise<WorkflowArtifact[]> {
    const artifacts = await this.prisma.artifact.findMany({
      where: { runId, revision },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return artifacts.map(toWorkflowArtifact);
  }

  async listArtifactsByIds(runId: string, artifactIds: readonly string[]): Promise<WorkflowArtifact[]> {
    const uniqueIds = [...new Set(artifactIds)];
    if (!uniqueIds.length) return [];
    const artifacts = await this.prisma.artifact.findMany({
      where: { runId, id: { in: uniqueIds } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return artifacts.map(toWorkflowArtifact);
  }

  async listArtifactsForSuccessfulStageJobs(runId: string, revision: number): Promise<WorkflowArtifact[]> {
    const jobs = await this.prisma.job.findMany({
      where: {
        runId,
        state: 'done',
        artifacts: { some: { revision: { lte: revision } } },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, stage: true },
    });
    const selectedJobIds = new Map<string, string>();
    for (const job of jobs) {
      if (!selectedJobIds.has(job.stage)) selectedJobIds.set(job.stage, job.id);
    }
    if (!selectedJobIds.size) return [];
    const successfulJobIds = jobs.map((job) => job.id);
    const reviewMedia = latestReviewMediaArtifacts((await this.prisma.artifact.findMany({
      where: {
        runId,
        revision: { lte: revision },
        jobId: { in: successfulJobIds },
        kind: { in: [...REVIEW_MEDIA_ARTIFACT_KINDS] },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })).map(toWorkflowArtifact));
    const selectedMediaJobIds = reviewMedia.flatMap((artifact) => artifact.jobId ? [artifact.jobId] : []);
    const selectedArtifactJobIds = [...new Set([...selectedJobIds.values(), ...selectedMediaJobIds])];
    const artifacts = await this.prisma.artifact.findMany({
      where: {
        runId,
        revision: { lte: revision },
        jobId: { in: selectedArtifactJobIds },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return latestReviewMediaArtifacts(artifacts.map(toWorkflowArtifact));
  }

  async getArtifact(runId: string, artifactId: string): Promise<WorkflowArtifact | null> {
    const artifact = await this.prisma.artifact.findFirst({ where: { id: artifactId, runId } });
    return artifact ? toWorkflowArtifact(artifact) : null;
  }

  async getReview(runId: string, packageChecksum: string): Promise<WorkflowReview | null> {
    return this.prisma.review.findUnique({
      where: { runId_packageChecksum: { runId, packageChecksum } },
    });
  }

  async getPackageVersion(runId: string, packageChecksum: string): Promise<WorkflowPackageVersion | null> {
    const version = await this.prisma.packageVersion.findFirst({
      where: { runId, packageChecksum },
      orderBy: [{ revision: 'desc' }, { createdAt: 'desc' }],
    });
    return version ? toWorkflowPackageVersion(version) : null;
  }

  async getPackageVersionById(id: string): Promise<WorkflowPackageVersion | null> {
    const version = await this.prisma.packageVersion.findUnique({ where: { id } });
    return version ? toWorkflowPackageVersion(version) : null;
  }

  async getDelivery(id: string): Promise<WorkflowDelivery | null> {
    const delivery = await this.prisma.delivery.findUnique({ where: { id } });
    return delivery ? toWorkflowDelivery(delivery) : null;
  }

  async getDeliveryForPackage(runId: string, packageChecksum: string): Promise<WorkflowDelivery | null> {
    const delivery = await this.prisma.delivery.findUnique({
      where: { runId_packageChecksum: { runId, packageChecksum } },
    });
    return delivery ? toWorkflowDelivery(delivery) : null;
  }

  async getJobContext(jobId: string): Promise<WorkflowJobContext | null> {
    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      include: {
        run: {
          include: {
            stages: true,
            jobs: { orderBy: { updatedAt: 'desc' } },
          },
        },
      },
    });
    if (!job) return null;

    const run = toWorkflowRun(job.run);
    const stage = run.stages[job.stage as WorkflowStage];
    if (!stage) throw new WorkflowConflictError('Current stage does not exist');
    return {
      job: toWorkflowJob(job),
      run,
      stage,
      packageChecksum: job.run.packageChecksum,
      approvedChecksum: job.run.approvedChecksum,
    };
  }

  async queueJob(input: QueueJobInput): Promise<WorkflowJob> {
    const job = await this.prisma.job.upsert({
      where: { idempotencyKey: input.idempotencyKey },
      update: {},
      create: {
        id: input.id,
        runId: input.runId,
        stage: input.stage,
        action: input.action,
        state: 'queued',
        idempotencyKey: input.idempotencyKey,
        availableAt: input.availableAt ?? new Date(),
        input: toPrismaJson(input.input),
      },
    });

    return toWorkflowJob(job);
  }

  async retryStage(input: RetryStageInput): Promise<WorkflowRun> {
    return this.prisma.$transaction(async (transaction) => {
      await lockRun(transaction, input.runId);
      const run = await transaction.run.findUnique({ where: { id: input.runId }, include: { stages: true } });
      if (!run) throw new WorkflowNotFoundError('Run not found');
      if (run.currentStage !== input.stage) throw new WorkflowConflictError('Only the current stage can be retried');
      const stage = run.stages.find((candidate) => candidate.name === input.stage);
      if (!stage || stage.state !== 'needs_human') {
        throw new WorkflowConflictError('Only a stage needing human intervention can be retried');
      }
      const previousJob = await transaction.job.findFirst({
        where: { runId: input.runId, stage: input.stage, state: 'needs_human' },
        orderBy: { updatedAt: 'desc' },
      });
      if (!previousJob) throw new WorkflowConflictError('No completed worker action is available to retry');
      const previousInput = previousJob.input as unknown as JsonObject;
      const retryDependencies = isLegacyMediaReconciliationInput(previousInput)
        ? await transaction.artifact.findMany({
          where: {
            runId: input.runId,
            revision: run.currentRevision,
            kind: 'parsed_output',
            action: { in: [ACTION_BY_STAGE.create, ACTION_BY_STAGE.check] },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
        : [];
      const now = new Date();
      await transaction.job.create({
        data: {
          id: randomUUID(),
          runId: input.runId,
          stage: input.stage,
          action: previousJob.action,
          state: 'queued',
          idempotencyKey: `workflow:${input.runId}:${input.stage}:manual-retry:${randomUUID()}`,
          availableAt: now,
          input: toPrismaJson({
            ...previousInput,
            ...(retryDependencies.length > 0
              ? { dependencies: retryDependencies.map(toWorkflowArtifact).map(toJobArtifactDependency) }
              : {}),
            ...(run.notebookLmNotebookId ? { notebookLmNotebookId: run.notebookLmNotebookId } : {}),
          }),
        },
      });
      await transaction.stage.update({
        where: { runId_name: { runId: input.runId, name: input.stage } },
        data: { state: 'queued', reason: null },
      });
      return toWorkflowRun(await transaction.run.findUniqueOrThrow({
        where: { id: input.runId },
        include: { stages: true, jobs: { where: { state: 'queued' }, orderBy: { availableAt: 'asc' }, take: 1 } },
      }));
    });
  }

  async refreshResearch(input: RefreshResearchInput): Promise<WorkflowRun> {
    return this.prisma.$transaction(async (transaction) => {
      await lockRun(transaction, input.runId);
      const run = await transaction.run.findUnique({
        where: { id: input.runId },
        include: { stages: true },
      });
      if (!run) throw new WorkflowNotFoundError('Run not found');
      assertResearchRefreshAllowed({
        currentStage: run.currentStage,
        reviewStatus: run.reviewStatus,
        approvedChecksum: run.approvedChecksum,
        createState: run.stages.find((stage) => stage.name === 'create')?.state,
      });
      const notebookLmNotebookId = run.notebookLmNotebookId ?? notebookIdFromBrief(input.brief);
      assertResearchRefreshBrief(input.brief, notebookLmNotebookId);
      const activeJobs = await transaction.job.count({
        where: { runId: input.runId, state: { in: ['queued', 'running'] } },
      });
      if (activeJobs > 0) {
        throw new WorkflowConflictError('Research refresh requires no active worker jobs');
      }
      const now = new Date();
      await transaction.run.update({
        where: { id: input.runId },
        data: {
          brief: toPrismaJson(input.brief),
          currentStage: 'research',
          currentRevision: { increment: 1 },
          packageChecksum: null,
          updatedAt: now,
        },
      });
      await transaction.stage.update({
        where: { runId_name: { runId: input.runId, name: 'research' } },
        data: { state: 'queued', reason: null },
      });
      await transaction.stage.update({
        where: { runId_name: { runId: input.runId, name: 'create' } },
        data: { state: 'queued', reason: null },
      });
      await transaction.job.create({
        data: {
          id: randomUUID(),
          runId: input.runId,
          stage: 'research',
          action: ACTION_BY_STAGE.research,
          state: 'queued',
          idempotencyKey: `workflow:${input.runId}:research:refresh:${randomUUID()}`,
          availableAt: now,
          input: toPrismaJson({
            brief: input.brief,
            ...(notebookLmNotebookId ? { notebookLmNotebookId } : {}),
            researchRefresh: { requestedBy: input.operatorId },
          }),
        },
      });
      return toWorkflowRun(await transaction.run.findUniqueOrThrow({
        where: { id: input.runId },
        include: {
          stages: true,
          jobs: { where: { state: 'queued' }, orderBy: { availableAt: 'asc' }, take: 1 },
        },
      }));
    });
  }

  async queueLegacyAudioReconciliation(runId: string): Promise<WorkflowRun> {
    return this.prisma.$transaction(async (transaction) => {
      await lockRun(transaction, runId);
      const run = await transaction.run.findUnique({ where: { id: runId }, include: { stages: true } });
      if (!run) throw new WorkflowNotFoundError('Run not found');
      const stage = run.stages.find((candidate) => candidate.name === 'human_review');
      if (run.currentStage !== 'human_review' || stage?.state !== 'needs_human') {
        throw new WorkflowConflictError('Legacy audio reconciliation requires a pending human review stage');
      }
      assertLegacyAudioReuse(run.brief as JsonObject);
      const activeJob = await transaction.job.findFirst({
        where: { runId, state: { in: ['queued', 'running'] } },
        select: { id: true },
      });
      if (activeJob) throw new WorkflowConflictError('The run already has active pipeline work');

      const transition = nextTransition({
        stage: 'human_review',
        state: 'needs_human',
        revisionAttempts: stage.revisionAttempt,
        packageChecksum: run.packageChecksum as `${string}` | null,
        approvedChecksum: run.approvedChecksum as `${string}` | null,
        reason: stage.reason ?? undefined,
      }, {
        type: 'media_reconciliation_requested',
        reason: 'Attach the existing Brief and Discussion audio files; do not generate audio.',
      });
      let packageVersion = run.packageChecksum
        ? await transaction.packageVersion.findFirst({
          where: { runId, packageChecksum: run.packageChecksum },
          orderBy: [{ revision: 'desc' }, { createdAt: 'desc' }],
        })
        : null;
      packageVersion ??= await transaction.packageVersion.findFirst({
        where: { runId },
        orderBy: [{ revision: 'desc' }, { createdAt: 'desc' }],
      });
      const dependencies = packageVersion
        ? await transaction.artifact.findMany({
          where: { runId, id: { in: packageArtifactIds(packageVersion.artifactInventory) } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
        : await transaction.artifact.findMany({
          where: {
            runId,
            revision: run.currentRevision,
            kind: 'parsed_output',
            action: { in: [ACTION_BY_STAGE.create, ACTION_BY_STAGE.check] },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
      const now = new Date();
      await transaction.stage.update({
        where: { runId_name: { runId, name: 'human_review' } },
        data: { state: 'done', reason: null },
      });
      await transaction.stage.upsert({
        where: { runId_name: { runId, name: 'produce_assets' } },
        update: { state: 'queued', reason: transition.reason ?? null, revisionAttempt: transition.revisionAttempts },
        create: {
          runId,
          name: 'produce_assets',
          state: 'queued',
          reason: transition.reason ?? null,
          revisionAttempt: transition.revisionAttempts,
        },
      });
      await transaction.run.update({
        where: { id: runId },
        data: {
          currentStage: 'produce_assets',
          packageChecksum: transition.packageChecksum,
          approvedChecksum: null,
          reviewStatus: 'pending',
        },
      });
      const effectId = randomUUID();
      await transaction.workflowEffect.create({
        data: {
          runId,
          jobId: `reconciliation:${effectId}`,
          effectKey: `reconciliation:${runId}:${run.currentRevision}`,
          type: 'queue_stage',
          payload: toPrismaJson({ type: 'queue_stage', stage: 'produce_assets' }),
        },
      });
      await transaction.job.create({
        data: {
          runId,
          stage: 'produce_assets',
          action: ACTION_BY_STAGE.produce_assets,
          state: 'queued',
          idempotencyKey: legacyAudioReconciliationJobIdempotencyKey(runId, run.currentRevision),
          availableAt: now,
          input: toPrismaJson({
            brief: run.brief as JsonObject,
            ...(run.notebookLmNotebookId ? { notebookLmNotebookId: run.notebookLmNotebookId } : {}),
            mediaOperation: 'attach_existing',
            mediaKinds: ['audio_brief', 'audio_discussion'],
            dependencies: dependencies.map(toWorkflowArtifact).map(toJobArtifactDependency),
          }),
        },
      });
      return toWorkflowRun(await transaction.run.findUniqueOrThrow({
        where: { id: runId },
        include: { stages: true, jobs: { where: { state: 'queued' }, orderBy: { availableAt: 'asc' }, take: 1 } },
      }));
    });
  }

  async queueMediaRegeneration(
    runId: string,
    kinds: readonly RegenerableMediaKind[],
    recipeOverrides?: MediaRecipeOverrides,
  ): Promise<WorkflowRun> {
    assertRegenerableMediaKinds(kinds);
    if (recipeOverrides?.heroMode === 'deferred' && kinds.includes('hero')) {
      throw new WorkflowValidationError('Deferred hero mode cannot regenerate the hero asset');
    }
    return this.prisma.$transaction(async (transaction) => {
      await lockRun(transaction, runId);
      const run = await transaction.run.findUnique({ where: { id: runId }, include: { stages: true } });
      if (!run) throw new WorkflowNotFoundError('Run not found');
      const reviewStage = run.stages.find((candidate) => candidate.name === 'human_review');
      const pendingReview = run.currentStage === 'human_review' && reviewStage?.state === 'needs_human';
      const approvedBeforeDelivery = run.currentStage === 'deliver' && run.reviewStatus === 'approved';
      if (!pendingReview && !approvedBeforeDelivery) {
        throw new WorkflowConflictError('Media regeneration requires pending review or approval awaiting delivery');
      }
      const activeJob = await transaction.job.findFirst({
        where: { runId, state: { in: ['queued', 'running'] } },
        select: { id: true, stage: true, state: true },
      });
      if (activeJob?.state === 'running' || (activeJob && activeJob.stage !== 'deliver')) {
        throw new WorkflowConflictError('The run already has active pipeline work');
      }
      const currentPackageVersion = run.packageChecksum
        ? await transaction.packageVersion.findFirst({
          where: { runId, packageChecksum: run.packageChecksum },
          orderBy: [{ revision: 'desc' }, { createdAt: 'desc' }],
        })
        : null;
      const packageVersion = currentPackageVersion ?? await transaction.packageVersion.findFirst({
        where: { runId },
        orderBy: [{ revision: 'desc' }, { createdAt: 'desc' }],
      });
      const dependencies = packageVersion
        ? await transaction.artifact.findMany({
          where: { runId, id: { in: packageArtifactIds(packageVersion.artifactInventory) } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
        : await transaction.artifact.findMany({
          where: {
            runId,
            revision: run.currentRevision,
            kind: 'parsed_output',
            action: { in: [ACTION_BY_STAGE.create, ACTION_BY_STAGE.check] },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
      if (!dependencies.length) throw new WorkflowConflictError('Media regeneration requires current content artifacts');
      const regenerationBrief = briefWithMediaRegenerationSource(
        briefWithMediaRecipeOverrides(run.brief as JsonObject, recipeOverrides),
        packageVersion?.packageChecksum,
        kinds,
      );
      const now = new Date();
      if (approvedBeforeDelivery) {
        await transaction.job.updateMany({
          where: { runId, stage: 'deliver', state: 'queued' },
          data: { state: 'superseded', leaseOwner: null, leaseExpiresAt: null, executionDeadlineAt: null },
        });
        await transaction.delivery.updateMany({
          where: { runId, state: { in: ['queued', 'waiting', 'failed'] } },
          data: { state: 'superseded', nextAttemptAt: null },
        });
      }
      await transaction.stage.update({
        where: { runId_name: { runId, name: 'human_review' } },
        data: { state: 'done', reason: null },
      });
      await transaction.stage.upsert({
        where: { runId_name: { runId, name: 'produce_assets' } },
        update: { state: 'queued', reason: `Regenerate ${kinds.join(', ')}`, revisionAttempt: 0 },
        create: { runId, name: 'produce_assets', state: 'queued', reason: `Regenerate ${kinds.join(', ')}`, revisionAttempt: 0 },
      });
      await transaction.run.update({
        where: { id: runId },
        data: {
          brief: toPrismaJson(regenerationBrief),
          currentStage: 'produce_assets',
          packageChecksum: null,
          approvedChecksum: null,
          reviewStatus: 'pending',
        },
      });
      await transaction.job.create({
        data: {
          runId,
          stage: 'produce_assets',
          action: ACTION_BY_STAGE.produce_assets,
          state: 'queued',
          idempotencyKey: `workflow:${runId}:produce_assets:media-regeneration:${run.currentRevision}:${randomUUID()}`,
          availableAt: now,
          input: toPrismaJson({
            brief: regenerationBrief,
            ...(run.notebookLmNotebookId ? { notebookLmNotebookId: run.notebookLmNotebookId } : {}),
            mediaOperation: 'generate',
            mediaKinds: [...kinds],
            dependencies: dependencies.map(toWorkflowArtifact).map(toJobArtifactDependency),
          }),
        },
      });
      return toWorkflowRun(await transaction.run.findUniqueOrThrow({
        where: { id: runId },
        include: { stages: true, jobs: { where: { state: 'queued' }, orderBy: { availableAt: 'asc' }, take: 1 } },
      }));
    });
  }

  async prepareLegacyRevision(input: PrepareLegacyRevisionInput): Promise<PrepareLegacyRevisionResult> {
    assertStrictLegacyReplacement(input);
    return this.prisma.$transaction(async (transaction) => {
      await lockRun(transaction, input.runId);
      const run = await transaction.run.findUnique({
        where: { id: input.runId },
        include: { stages: true },
      });
      if (!run) throw new WorkflowNotFoundError('Run not found');
      const operation = legacyRevisionOperation(input);
      const existingEffect = await transaction.workflowEffect.findUnique({ where: { effectKey: operation.effectKey } });
      if (existingEffect) {
        assertLegacyRevisionReplay(existingEffect.payload, operation.payload);
        if (run.currentRevision !== input.expectedRevision + 1
          || run.currentStage !== 'research'
          || run.packageChecksum !== null
          || run.approvedChecksum !== null
          || run.reviewStatus !== 'pending'
          || legacyBriefChecksum(run.brief as JsonObject) !== operation.replacementBriefChecksum) {
          throw new WorkflowConflictError('Legacy revision preparation replay does not match the prepared run');
        }
        return {
          run: toWorkflowRun(run),
          previousRevision: input.expectedRevision,
          previousPackageChecksum: input.expectedPackageChecksum,
        };
      }
      assertLegacyRevisionFence(run, input);
      const nextRevision = run.currentRevision + 1;
      const now = new Date();
      await transaction.job.updateMany({
        where: { runId: run.id, state: { in: ['queued', 'running'] } },
        data: {
          state: 'superseded',
          leaseOwner: null,
          leaseExpiresAt: null,
          executionDeadlineAt: null,
        },
      });
      for (const stage of WORKFLOW_STAGES) {
        await transaction.stage.upsert({
          where: { runId_name: { runId: run.id, name: stage } },
          update: { state: 'queued', reason: null, attempt: 0, revisionAttempt: 0 },
          create: { runId: run.id, name: stage, state: 'queued', reason: null, attempt: 0, revisionAttempt: 0 },
        });
      }
      await transaction.run.update({
        where: { id: run.id },
        data: {
          brief: toPrismaJson(input.brief),
          currentStage: 'research',
          currentRevision: nextRevision,
          packageChecksum: null,
          approvedChecksum: null,
          reviewStatus: 'pending',
        },
      });
      await transaction.job.create({
        data: {
          runId: run.id,
          stage: 'research',
          action: ACTION_BY_STAGE.research,
          state: 'queued',
          idempotencyKey: transitionJobIdempotencyKey(run.id, 'research', nextRevision),
          availableAt: now,
          input: toPrismaJson({ brief: input.brief, notebookLmNotebookId: input.notebookLmNotebookId }),
        },
      });
      await transaction.workflowEffect.create({
        data: {
          runId: run.id,
          jobId: `legacy-revision:${input.expectedRevision}`,
          effectKey: operation.effectKey,
          type: 'prepare_legacy_revision',
          payload: toPrismaJson(operation.payload),
        },
      });
      const updated = await transaction.run.findUniqueOrThrow({
        where: { id: run.id },
        include: { stages: true, jobs: { where: { state: 'queued' }, orderBy: { availableAt: 'asc' }, take: 1 } },
      });
      return {
        run: toWorkflowRun(updated),
        previousRevision: input.expectedRevision,
        previousPackageChecksum: input.expectedPackageChecksum,
      };
    });
  }

  async claimJob(input: ClaimJobInput): Promise<JobClaim | null> {
    assertWorkerId(input.workerId);
    assertLeaseSeconds(input.leaseSeconds);
    assertExecutionSeconds(input.executionSeconds);
    assertCapabilities(input.capabilities);
    const claimedAt = input.now ?? new Date();
    const leaseExpiresAt = new Date(claimedAt.getTime() + input.leaseSeconds * 1_000);
    const executionDeadlineAt = new Date(claimedAt.getTime() + (input.executionSeconds ?? DEFAULT_JOB_EXECUTION_SECONDS) * 1_000);
    const createContentExecutionDeadlineAt = new Date(
      claimedAt.getTime() + (input.executionSeconds ?? CREATE_CONTENT_JOB_EXECUTION_SECONDS) * 1_000,
    );
    const produceAssetsExecutionDeadlineAt = new Date(
      claimedAt.getTime() + (input.executionSeconds ?? PRODUCE_ASSETS_JOB_EXECUTION_SECONDS) * 1_000,
    );
    const capabilityFilter = input.capabilities?.length
      ? Prisma.sql`AND "action" IN (${Prisma.join(input.capabilities)})`
      : Prisma.empty;
    const preferredRunFilter = input.preferredRunId
      ? Prisma.sql`AND "Run"."id" = ${input.preferredRunId}`
      : Prisma.empty;
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`
        WITH released AS (
          UPDATE "Job"
          SET "state" = 'queued',
              "leaseOwner" = NULL,
              "leaseExpiresAt" = NULL,
              "executionDeadlineAt" = NULL,
              "availableAt" = ${claimedAt},
              "updatedAt" = ${claimedAt}
          WHERE "state" = 'running' AND "leaseExpiresAt" <= ${claimedAt}
          RETURNING "id", "runId", "stage"
        )
        UPDATE "Stage"
        SET "state" = 'queued',
            "reason" = NULL,
            "updatedAt" = ${claimedAt}
        FROM (SELECT DISTINCT "runId", "stage" FROM released) AS "released"
        WHERE "Stage"."runId" = "released"."runId"
          AND "Stage"."name" = "released"."stage"
          AND "Stage"."state" = 'running'
          AND NOT EXISTS (
            SELECT 1 FROM "Job"
            WHERE "Job"."runId" = "Stage"."runId"
              AND "Job"."stage" = "Stage"."name"
              AND "Job"."state" = 'running'
          )
      `);
      const rows = await transaction.$queryRaw<ClaimedJobRow[]>(Prisma.sql`
      UPDATE "Job"
      SET "state" = 'running',
          "leaseOwner" = ${input.workerId},
          "leaseExpiresAt" = ${leaseExpiresAt},
          "executionDeadlineAt" = CASE
            WHEN "action" = 'create_content' THEN ${createContentExecutionDeadlineAt}
            WHEN "action" = 'produce_assets' THEN ${produceAssetsExecutionDeadlineAt}
            ELSE ${executionDeadlineAt}
          END,
          "attempt" = "attempt" + 1,
          "updatedAt" = ${claimedAt}
      WHERE "id" = (
        SELECT "Job"."id"
        FROM "Job"
        INNER JOIN "Run" ON "Run"."id" = "Job"."runId"
        WHERE "Job"."state" = 'queued'
          AND "Job"."availableAt" <= ${claimedAt}
          AND "Run"."currentStage" = "Job"."stage"
          AND (
            "Job"."stage" <> 'deliver'
            OR (
              "Run"."approvedChecksum" IS NOT NULL
              AND "Job"."input"->>'packageChecksum' = "Run"."approvedChecksum"
            )
          )
          ${capabilityFilter}
          ${preferredRunFilter}
        ORDER BY CASE "Job"."stage"
            WHEN 'deliver' THEN 5
            WHEN 'produce_assets' THEN 4
            WHEN 'check' THEN 3
            WHEN 'create' THEN 2
            WHEN 'research' THEN 1
            ELSE 0
          END DESC,
          "Job"."availableAt" ASC,
          "Job"."createdAt" ASC
        FOR UPDATE OF "Job", "Run" SKIP LOCKED
        LIMIT 1
      ) AND "state" = 'queued'
      RETURNING "id", "runId", "stage", "attempt", "leaseExpiresAt", "executionDeadlineAt", "input",
        (SELECT "currentRevision" FROM "Run" WHERE "Run"."id" = "Job"."runId") AS "revision"
      `);
      const row = rows[0];

      if (!row) return null;
      await transaction.stage.update({
        where: { runId_name: { runId: row.runId, name: row.stage } },
        data: { state: 'running', reason: null, attempt: row.attempt },
      });

      const deliveryInput = row.stage === 'deliver' ? row.input as JsonObject : undefined;
      return {
        jobId: row.id,
        packageId: row.runId,
        stage: row.stage as WorkflowStage,
        claimedBy: input.workerId,
        claimedAt: claimedAt.toISOString(),
        leaseExpiresAt: row.leaseExpiresAt.toISOString(),
        executionDeadlineAt: row.executionDeadlineAt.toISOString(),
        attempt: row.attempt,
        revision: row.revision,
        input: row.input as JsonObject,
        ...(deliveryInput ? deliveryClaimIdentity(deliveryInput) : {}),
      };
    });
  }

  async renewJobLease(input: RenewJobLeaseInput): Promise<void> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE "Job"
      SET "leaseExpiresAt" = CURRENT_TIMESTAMP + ("Job"."leaseExpiresAt" - "Job"."updatedAt"),
          "updatedAt" = CURRENT_TIMESTAMP
      FROM "Run"
      WHERE "Job"."id" = ${input.jobId}
        AND "Job"."runId" = "Run"."id"
        AND "Job"."state" = 'running'
        AND "Job"."leaseOwner" = ${input.workerId}
        AND "Job"."leaseExpiresAt" > CURRENT_TIMESTAMP
        AND "Job"."executionDeadlineAt" > CURRENT_TIMESTAMP
        AND "Run"."currentStage" = "Job"."stage"
      RETURNING "Job"."id"
    `);
    if (!rows[0]) throw new WorkflowConflictError('Job lease is no longer valid');
  }

  async completeJob(input: CompleteJobInput): Promise<JobResult> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE "Job"
      SET "state" = ${input.result.state},
          "result" = CAST(${JSON.stringify(input.result)} AS jsonb),
          "leaseOwner" = NULL,
          "leaseExpiresAt" = NULL,
          "executionDeadlineAt" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${input.result.jobId}
        AND "runId" = ${input.result.packageId}
        AND "stage" = ${input.result.stage}
        AND "state" = 'running'
        AND "leaseOwner" = ${input.workerId}
        AND "leaseExpiresAt" > CURRENT_TIMESTAMP
      RETURNING "id"
    `);

    if (!rows[0]) throw new WorkflowConflictError('Job lease is no longer valid');
    return input.result;
  }

  async hasActiveJobLease(input: HasActiveJobLeaseInput): Promise<boolean> {
    const job = await this.prisma.job.findFirst({
      where: {
        id: input.jobId,
        runId: input.runId,
        state: 'running',
        leaseOwner: input.workerId,
        leaseExpiresAt: { gt: input.now ?? new Date() },
      },
      select: { id: true },
    });
    return Boolean(job);
  }

  async hasActiveArtifactLease(input: HasActiveArtifactLeaseInput): Promise<boolean> {
    const job = await this.prisma.job.findFirst({
      where: {
        id: input.jobId,
        runId: input.runId,
        OR: [
          { stage: 'produce_assets', action: 'produce_assets' },
          ...(input.kind === 'source_snapshot' ? [
            { stage: 'research', action: 'collect_sources' },
          ] : []),
          ...(AUDIT_ARTIFACT_KINDS.has(input.kind) ? [
            { stage: 'research', action: 'collect_sources' },
            { stage: 'create', action: 'create_content' },
            { stage: 'check', action: 'check_content' },
            { stage: 'produce_assets', action: 'produce_assets' },
            { stage: 'deliver', action: 'deliver_package' },
          ] : []),
        ],
        state: 'running',
        leaseOwner: input.workerId,
        leaseExpiresAt: { gt: input.now ?? new Date() },
        run: { currentRevision: input.revision },
      },
      select: { id: true },
    });
    return Boolean(job);
  }

  async applyJobResult(input: ApplyJobResultInput): Promise<WorkflowRun> {
    return this.prisma.$transaction(async (transaction) => {
      const now = new Date();
      const job = await transaction.job.findUnique({
        where: { id: input.result.jobId },
        include: { run: { include: { stages: true } } },
      });
      const receiptInput = completionReceiptInput(input);
      if (job?.completionReceipt) return replayCompletionReceipt(job.completionReceipt, receiptInput);
      assertRetryAtInFuture(input.retryAt, now);
      const transition = input.transition;
      if (!transition) throw new WorkflowConflictError('A new job result requires a transition');
      if (
        !job
        || job.runId !== input.result.packageId
        || job.stage !== input.result.stage
        || job.state !== 'running'
        || job.leaseOwner !== input.workerId
        || !job.leaseExpiresAt
        || job.leaseExpiresAt <= now
        || job.run.currentStage !== job.stage
      ) {
        throw new WorkflowConflictError('Job lease is no longer valid');
      }

      const currentStage = job.run.stages.find((stage) => stage.name === job.stage);
      if (!currentStage) throw new WorkflowConflictError('Current stage does not exist');
      const nextRevision = job.run.currentRevision
        + Number(transition.revisionAttempts > currentStage.revisionAttempt);
      const completedArtifacts = (await transaction.artifact.findMany({
        where: { jobId: job.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })).map(toWorkflowArtifact);
      const completed = await transaction.$executeRaw(Prisma.sql`
        UPDATE "Job"
        SET "state" = ${input.result.state},
            "result" = CAST(${JSON.stringify(input.result)} AS jsonb),
            "leaseOwner" = NULL,
            "leaseExpiresAt" = NULL,
            "executionDeadlineAt" = NULL,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${job.id}
          AND "state" = 'running'
          AND "leaseOwner" = ${input.workerId}
          AND "leaseExpiresAt" > CURRENT_TIMESTAMP
      `);
      if (completed !== 1) {
        const completedJob = await transaction.job.findUnique({ where: { id: input.result.jobId } });
        if (completedJob?.completionReceipt) {
          return replayCompletionReceipt(completedJob.completionReceipt, receiptInput);
        }
        throw new WorkflowConflictError('Job lease is no longer valid');
      }
      if (transition.stage !== job.stage) {
        await transaction.stage.update({
          where: { runId_name: { runId: job.runId, name: job.stage } },
          data: { state: 'done', reason: null },
        });
      }
      await transaction.stage.upsert({
        where: { runId_name: { runId: job.runId, name: transition.stage } },
        update: {
          state: transition.state,
          reason: transition.reason ?? null,
          revisionAttempt: transition.revisionAttempts,
        },
        create: {
          runId: job.runId,
          name: transition.stage,
          state: transition.state,
          reason: transition.reason ?? null,
          revisionAttempt: transition.revisionAttempts,
        },
      });
      await transaction.run.update({
        where: { id: job.runId },
        data: {
          currentStage: transition.stage,
          currentRevision: nextRevision,
          packageChecksum: transition.packageChecksum,
          approvedChecksum: transition.approvedChecksum,
          reviewStatus: reviewStatusForTransition(job.run.reviewStatus as ReviewStatus, transition),
        },
      });
      for (const [index, effect] of transition.effects.entries()) {
        await transaction.workflowEffect.create({
          data: {
            runId: job.runId,
            jobId: job.id,
            effectKey: workflowEffectKey(job.id, index),
            type: effect.type,
            payload: toPrismaJson(effect as unknown as JsonObject),
          },
        });
          if (effect.type === 'queue_stage') {
            if (effect.stage === 'human_review') {
              throw new WorkflowConflictError('Human review cannot be queued as a worker job');
            }
            await queueTransitionJob(transaction, {
              runId: job.runId,
              stage: effect.stage,
              revision: nextRevision,
              input: {
                brief: job.run.brief as JsonObject,
                ...(job.run.notebookLmNotebookId ? { notebookLmNotebookId: job.run.notebookLmNotebookId } : {}),
                ...mediaJobInputForStage(job.run.brief as JsonObject, effect.stage),
                dependencies: nextJobDependencies(job.input as JsonObject, completedArtifacts, effect.stage),
              },
            });
        }
        if (effect.type === 'queue_delivery') {
          const packageVersion = await transaction.packageVersion.findUnique({
            where: {
              runId_revision_packageChecksum: {
                runId: job.runId,
                revision: nextRevision,
                packageChecksum: effect.packageChecksum,
              },
            },
          });
          if (!packageVersion) throw new WorkflowConflictError('Delivery requires a persisted immutable package version');
          const deliveryId = randomUUID();
          await queueTransitionJob(transaction, {
              runId: job.runId,
              stage: 'deliver',
              revision: nextRevision,
              input: {
                brief: job.run.brief as JsonObject,
                ...(job.run.notebookLmNotebookId ? { notebookLmNotebookId: job.run.notebookLmNotebookId } : {}),
                deliveryId,
                packageChecksum: effect.packageChecksum,
                packageVersionId: packageVersion.id,
              },
          });
          await transaction.delivery.create({
            data: {
              id: deliveryId,
              runId: job.runId,
              packageVersionId: packageVersion.id,
              target: packageTargetKind(packageVersion.content),
              packageChecksum: effect.packageChecksum,
              idempotencyKey: externalDeliveryIdempotencyKey(packageVersion.id, effect.packageChecksum),
              state: 'queued',
            },
          });
        }
        if (effect.type === 'request_review') {
          assertDurableEffect(
            transition.stage === 'human_review' && transition.state === 'needs_human',
            'Review request was not represented by the human-review stage',
          );
        }
        if (effect.type === 'request_human') {
          assertDurableEffect(
            transition.state === 'needs_human' && transition.stage !== 'human_review',
            'Human request was not represented by an automated stage',
          );
        }
        if (effect.type === 'record_delivery') {
          assertDurableEffect(
            transition.stage === 'deliver' && transition.state === 'done',
            'Delivery record was not represented by the delivery stage',
          );
        }
      }
      if (input.retryAt) {
        await transaction.job.create({
          data: {
            runId: job.runId,
            stage: job.stage,
            action: job.action,
            state: 'queued',
            idempotencyKey: retryJobIdempotencyKey(job.id, job.attempt),
            availableAt: input.retryAt,
            input: toPrismaJson(job.input as JsonObject),
          },
        });
      }
      const run = await transaction.run.findUniqueOrThrow({
        where: { id: job.runId },
        include: {
          stages: true,
          jobs: { where: { state: 'queued' }, orderBy: { availableAt: 'asc' }, take: 1 },
        },
      });
      const workflowRun = toWorkflowRun(run);
      await transaction.job.update({
        where: { id: job.id },
        data: { completionReceipt: toPrismaJson(createCompletionReceipt(receiptInput, workflowRun) as unknown as JsonObject) },
      });
      return workflowRun;
    });
  }

  async releaseExpiredLeases(input: { now?: Date } = {}): Promise<number> {
    const now = input.now ?? new Date();

    const rows = await this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      WITH released AS (
        UPDATE "Job"
        SET "state" = 'queued',
            "leaseOwner" = NULL,
            "leaseExpiresAt" = NULL,
            "executionDeadlineAt" = NULL,
            "availableAt" = ${now},
            "updatedAt" = ${now}
        WHERE "state" = 'running' AND "leaseExpiresAt" <= ${now}
        RETURNING "id", "runId", "stage"
      ), synchronized AS (
        UPDATE "Stage"
        SET "state" = 'queued',
            "reason" = NULL,
            "updatedAt" = ${now}
        FROM (SELECT DISTINCT "runId", "stage" FROM released) AS "released"
        WHERE "Stage"."runId" = "released"."runId"
          AND "Stage"."name" = "released"."stage"
          AND "Stage"."state" = 'running'
          AND NOT EXISTS (
            SELECT 1 FROM "Job"
            WHERE "Job"."runId" = "Stage"."runId"
              AND "Job"."stage" = "Stage"."name"
              AND "Job"."state" = 'running'
              AND "Job"."id" NOT IN (SELECT "id" FROM released)
          )
      )
      SELECT count(*)::bigint AS "count" FROM released
    `);
    return Number(rows[0]?.count ?? 0n);
  }

  async recordArtifact(input: RecordArtifactInput): Promise<WorkflowArtifact> {
    try {
      const artifact = await this.prisma.artifact.create({
        data: {
          id: input.id,
          runId: input.runId,
          revision: input.revision,
          kind: input.kind,
          mediaType: input.mediaType,
          checksum: input.checksum,
          storageKey: input.storageKey,
          byteSize: input.byteSize,
          provenance: toPrismaJson(input.provenance),
          inputChecksum: input.inputChecksum,
          jobId: input.jobId,
          stage: input.stage,
          action: input.action,
        },
      });

      return toWorkflowArtifact(artifact);
    } catch (error) {
      throwArtifactUniqueConflict(error);
    }
  }

  async recordArtifactForActiveLease(input: RecordArtifactForActiveLeaseInput): Promise<WorkflowArtifact> {
    const artifactId = input.id ?? randomUUID();
    try {
      const artifacts = await this.prisma.$queryRaw<WorkflowArtifact[]>(Prisma.sql`
        INSERT INTO "Artifact" (
          "id", "runId", "revision", "kind", "mediaType", "checksum", "storageKey", "byteSize", "provenance", "inputChecksum",
          "jobId", "stage", "action"
        )
        SELECT
          ${artifactId}, ${input.runId}, ${input.revision}, ${input.kind}, ${input.mediaType}, ${input.checksum},
          ${input.storageKey}, ${input.byteSize},
          CAST(${JSON.stringify(input.provenance)} AS jsonb) || jsonb_build_object(
            'jobId', "Job"."id",
            'stage', "Job"."stage",
            'action', "Job"."action"
          ),
          ${input.inputChecksum}, "Job"."id", "Job"."stage", "Job"."action"
        FROM "Job"
        INNER JOIN "Run" ON "Run"."id" = "Job"."runId"
        WHERE "Job"."id" = ${input.jobId}
          AND "Job"."runId" = ${input.runId}
          AND (
            ("Job"."stage" = 'produce_assets' AND "Job"."action" = 'produce_assets')
            OR (
              ${input.kind} = 'source_snapshot'
              AND "Job"."stage" = 'research'
              AND "Job"."action" = 'collect_sources'
            )
            OR (
              ${input.kind} IN (
                'raw_response',
                'parsed_output',
                'execution_report',
                'generation.recipe.snapshot',
                'generation.prompt.rendered',
                'generation.execution.report'
              )
              AND (
                ("Job"."stage" = 'research' AND "Job"."action" = 'collect_sources')
                OR ("Job"."stage" = 'create' AND "Job"."action" = 'create_content')
                OR ("Job"."stage" = 'check' AND "Job"."action" = 'check_content')
                OR ("Job"."stage" = 'produce_assets' AND "Job"."action" = 'produce_assets')
                OR ("Job"."stage" = 'deliver' AND "Job"."action" = 'deliver_package')
              )
            )
          )
          AND "Job"."state" = 'running'
          AND "Job"."leaseOwner" = ${input.workerId}
          AND "Job"."leaseExpiresAt" > CURRENT_TIMESTAMP
          AND "Run"."currentRevision" = ${input.revision}
        RETURNING
          "id", "runId", "revision", "kind", "mediaType", "checksum", "storageKey", "byteSize", "provenance", "inputChecksum",
          "jobId", "stage", "action", "createdAt"
      `);
      const artifact = artifacts[0];
      if (!artifact) throw new WorkflowConflictError('Artifact-producing job lease is no longer valid');
      return artifact;
    } catch (error) {
      throwArtifactUniqueConflict(error);
    }
  }

  async recordReview(input: RecordReviewInput): Promise<WorkflowReview> {
    const where = {
      runId_packageChecksum: {
        runId: input.runId,
        packageChecksum: input.packageChecksum,
      },
    };
    const existing = await this.prisma.review.findUnique({ where });
    if (existing) return resolveExistingReview(existing, input);

    try {
      const review = await this.prisma.review.create({
        data: input,
      });

      return review;
    } catch (error) {
      if (isPrismaUniqueConflict(error)) {
        const concurrentlyCreated = await this.prisma.review.findUnique({ where });
        if (concurrentlyCreated) return resolveExistingReview(concurrentlyCreated, input);
      }

      throw error;
    }
  }

  async recordDelivery(input: RecordDeliveryInput): Promise<WorkflowDelivery> {
    const delivery = await this.prisma.delivery.upsert({
      where: { idempotencyKey: input.idempotencyKey },
      update: {},
      create: {
        id: input.id,
        runId: input.runId,
        packageVersionId: input.packageVersionId,
        target: input.target,
        packageChecksum: input.packageChecksum,
        idempotencyKey: input.idempotencyKey,
        state: input.state,
        response: input.response ? toPrismaJson(input.response) : undefined,
        nextAttemptAt: input.nextAttemptAt,
      },
    });

    return toWorkflowDelivery(delivery);
  }

  async transitionDeliveryForActiveLease(input: TransitionDeliveryInput): Promise<WorkflowDelivery> {
    const result = await this.prisma.$transaction(async (transaction) => {
      const identity = await transaction.delivery.findUnique({
        where: { id: input.id },
        select: { runId: true },
      });
      if (!identity) throw new WorkflowNotFoundError('Delivery not found');
      await lockRun(transaction, identity.runId);
      await transaction.$queryRaw(Prisma.sql`
        SELECT "id" FROM "Delivery" WHERE "id" = ${input.id} FOR UPDATE
      `);
      const now = input.now ?? new Date();
      const [delivery, run, job, review, packageVersion] = await Promise.all([
        transaction.delivery.findUniqueOrThrow({ where: { id: input.id } }),
        transaction.run.findUniqueOrThrow({ where: { id: identity.runId } }),
        transaction.job.findUnique({ where: { id: input.jobId } }),
        transaction.review.findUnique({
          where: { runId_packageChecksum: { runId: identity.runId, packageChecksum: input.packageChecksum } },
        }),
        transaction.packageVersion.findUnique({ where: { id: input.packageVersionId } }),
      ]);
      const jobInput = job?.input as JsonObject | undefined;
      const fenceMatches = delivery.state === input.expectedState
        && (input.expectedState !== 'waiting'
          || Boolean(delivery.nextAttemptAt && delivery.nextAttemptAt <= now))
        && delivery.packageVersionId === input.packageVersionId
        && delivery.packageChecksum === input.packageChecksum
        && run.currentStage === 'deliver'
        && run.packageChecksum === input.packageChecksum
        && run.approvedChecksum === input.packageChecksum
        && review?.decision === 'approve'
        && packageVersion?.runId === delivery.runId
        && packageVersion.revision === run.currentRevision
        && packageVersion.packageChecksum === input.packageChecksum
        && job?.runId === delivery.runId
        && job.stage === 'deliver'
        && job.action === ACTION_BY_STAGE.deliver
        && job.state === 'running'
        && job.leaseOwner === input.workerId
        && Boolean(job.leaseExpiresAt && job.leaseExpiresAt > now)
        && jobInput?.deliveryId === delivery.id
        && jobInput.packageVersionId === input.packageVersionId
        && jobInput.packageChecksum === input.packageChecksum;

      if (!fenceMatches) {
        const audited = input.response === undefined
          ? delivery
          : await transaction.delivery.update({
            where: { id: delivery.id },
            data: { response: toPrismaJson(mergeLateDeliveryEvidence(delivery.response, input.response)) },
          });
        return { delivery: toWorkflowDelivery(audited), transitioned: false };
      }

      const updated = await transaction.delivery.update({
        where: { id: delivery.id },
        data: {
          state: input.state,
          ...(input.response !== undefined
            ? { response: toPrismaJson(mergeDeliveryResponse(delivery.response, input.response)) }
            : {}),
          ...(input.nextAttemptAt !== undefined ? { nextAttemptAt: input.nextAttemptAt } : {}),
          ...(input.incrementAttempts ? { attempts: { increment: 1 } } : {}),
        },
      });
      return { delivery: toWorkflowDelivery(updated), transitioned: true };
    });
    if (!result.transitioned) throw new WorkflowConflictError('Delivery transition fence no longer matches');
    return result.delivery;
  }

  async retryDelivery(deliveryId: string): Promise<RetryDeliveryResult> {
    return this.prisma.$transaction(async (transaction) => {
      const now = new Date();
      const locked = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "Delivery"."id"
        FROM "Delivery"
        INNER JOIN "Run" ON "Run"."id" = "Delivery"."runId"
        WHERE "Delivery"."id" = ${deliveryId}
        FOR UPDATE OF "Delivery", "Run"
      `);
      if (!locked[0]) throw new WorkflowNotFoundError('Delivery not found');
      const delivery = await transaction.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
      const run = await transaction.run.findUniqueOrThrow({ where: { id: delivery.runId } });
      if (!['failed', 'waiting', 'running', 'verifying', 'succeeded', 'needs_human'].includes(delivery.state)) {
        throw new WorkflowConflictError('Delivery state is not recoverable');
      }
      if (run.packageChecksum !== delivery.packageChecksum || run.approvedChecksum !== delivery.packageChecksum) {
        throw new WorkflowConflictError('Delivery checksum no longer matches the current approval');
      }
      const recoveryJobs = await transaction.job.findMany({
        where: {
          runId: delivery.runId,
          stage: 'deliver',
          state: { in: ['queued', 'running'] },
          input: { path: ['deliveryId'], equals: delivery.id },
        },
        orderBy: { createdAt: 'desc' },
      });
      const active = recoveryJobs.find((job) => (
        job.state === 'running' && job.leaseExpiresAt && job.leaseExpiresAt > now
      ));
      if (active) throw new WorkflowConflictError('Delivery execution has an active lease');
      const queued = recoveryJobs.find((job) => job.state === 'queued');
      const expired = recoveryJobs.find((job) => job.state === 'running');
      const nextAttempt = delivery.attempts + 1;
      if (queued) {
        if (queued.availableAt <= now) throw new WorkflowConflictError('Delivery recovery is already queued');
        await transaction.job.update({ where: { id: queued.id }, data: { availableAt: now } });
        if (expired) {
          await transaction.job.update({
            where: { id: expired.id },
            data: { state: 'superseded', leaseOwner: null, leaseExpiresAt: null, executionDeadlineAt: null },
          });
        }
      } else if (expired) {
        await transaction.job.update({
          where: { id: expired.id },
          data: {
            state: 'queued',
            leaseOwner: null,
            leaseExpiresAt: null,
            executionDeadlineAt: null,
            availableAt: now,
          },
        });
      } else {
        await transaction.job.create({
          data: {
            runId: delivery.runId,
            stage: 'deliver',
            action: ACTION_BY_STAGE.deliver,
            state: 'queued',
            idempotencyKey: deliveryRetryJobIdempotencyKey(delivery.id, nextAttempt),
            input: toPrismaJson(deliveryJobInput(toWorkflowDelivery(delivery), run.brief as JsonObject)),
          },
        });
      }
      await transaction.stage.update({
        where: { runId_name: { runId: delivery.runId, name: 'deliver' } },
        data: { state: 'queued', reason: null },
      });
      const updated = await transaction.delivery.update({
        where: { id: delivery.id },
        data: {
          state: delivery.state === 'needs_human' ? 'waiting' : delivery.state,
          nextAttemptAt: ['failed', 'waiting', 'needs_human'].includes(delivery.state)
            ? now
            : delivery.nextAttemptAt,
        },
      });
      return { delivery: toWorkflowDelivery(updated), nextAttempt };
    });
  }

  async reviewRun(input: ReviewRunInput): Promise<WorkflowRun> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await lockRun(transaction, input.runId);
        const run = await transaction.run.findUnique({
          where: { id: input.runId },
          include: { stages: true },
        });
        if (!run) throw new WorkflowNotFoundError('Run not found');
        const reviewInput = toRecordReviewInput(run, input);
        const existing = await transaction.review.findUnique({
          where: { runId_packageChecksum: reviewIdentityWhere(reviewInput) },
        });
        if (existing) {
          resolveExistingReview(existing, reviewInput);
          return toWorkflowRun(run);
        }
        if (run.packageChecksum !== input.packageChecksum) {
          throw new WorkflowConflictError('Review checksum must match the current package checksum');
        }
        const packageVersion = await transaction.packageVersion.findUnique({
          where: {
            runId_revision_packageChecksum: {
              runId: run.id,
              revision: run.currentRevision,
              packageChecksum: input.packageChecksum,
            },
          },
        });
        if (!packageVersion) {
          throw new WorkflowConflictError('Review requires a persisted immutable package version');
        }

        const stage = run.stages.find((candidate) => candidate.name === run.currentStage);
        if (!stage) throw new WorkflowConflictError('Current stage does not exist');
        const transition = nextTransition({
          stage: run.currentStage as WorkflowStage,
          state: stage.state as StageState,
          revisionAttempts: stage.revisionAttempt,
          packageChecksum: run.packageChecksum as `${string}`,
          approvedChecksum: run.approvedChecksum as `${string}` | null,
          reason: stage.reason ?? undefined,
        }, reviewEvent(input));
        const nextRevision = run.currentRevision + Number(input.decision === 'request_changes');
        const review = await transaction.review.create({ data: reviewInput });

        if (transition.stage !== run.currentStage) {
          await transaction.stage.update({
            where: { runId_name: { runId: run.id, name: run.currentStage } },
            data: { state: 'done', reason: null },
          });
        }
        await transaction.stage.upsert({
          where: { runId_name: { runId: run.id, name: transition.stage } },
          update: { state: transition.state, reason: transition.reason ?? null, revisionAttempt: transition.revisionAttempts },
          create: {
            runId: run.id,
            name: transition.stage,
            state: transition.state,
            reason: transition.reason ?? null,
            revisionAttempt: transition.revisionAttempts,
          },
        });
        await transaction.run.update({
          where: { id: run.id },
          data: {
            currentStage: transition.stage,
            currentRevision: nextRevision,
            packageChecksum: transition.packageChecksum,
            approvedChecksum: transition.approvedChecksum,
            reviewStatus: reviewStatusForDecision(input.decision),
          },
        });
        for (const [index, effect] of transition.effects.entries()) {
          await transaction.workflowEffect.create({
            data: {
              runId: run.id,
              jobId: `review:${review.id}`,
              effectKey: `review:${review.id}:effect:${index}`,
              type: effect.type,
              payload: toPrismaJson(effect as unknown as JsonObject),
            },
          });
          if (effect.type === 'queue_delivery') {
            const deliveryId = randomUUID();
            await queueTransitionJob(transaction, {
              runId: run.id,
              stage: 'deliver',
              revision: nextRevision,
              input: {
                brief: run.brief as JsonObject,
                ...(run.notebookLmNotebookId ? { notebookLmNotebookId: run.notebookLmNotebookId } : {}),
                deliveryId,
                packageChecksum: effect.packageChecksum,
                packageVersionId: packageVersion.id,
              },
            });
            await transaction.delivery.create({
              data: {
                id: deliveryId,
                runId: run.id,
                packageVersionId: packageVersion.id,
                target: packageTargetKind(packageVersion.content),
                packageChecksum: effect.packageChecksum,
                idempotencyKey: externalDeliveryIdempotencyKey(packageVersion.id, effect.packageChecksum),
                state: 'queued',
              },
            });
          }
          if (effect.type === 'queue_stage') {
            if (effect.stage === 'human_review') {
              throw new WorkflowConflictError('Human review cannot be queued as a worker job');
            }
            const packageArtifacts = await transaction.artifact.findMany({
              where: {
                runId: run.id,
                id: { in: packageArtifactIds(packageVersion.artifactInventory) },
                action: ACTION_BY_STAGE.research,
              },
            });
            await queueTransitionJob(transaction, {
              runId: run.id,
              stage: effect.stage,
              revision: nextRevision,
              input: {
                brief: run.brief as JsonObject,
                ...(run.notebookLmNotebookId ? { notebookLmNotebookId: run.notebookLmNotebookId } : {}),
                dependencies: packageArtifacts.map(toWorkflowArtifact).map(toJobArtifactDependency),
                review: { comment: input.comment!, packageChecksum: input.packageChecksum },
              },
            });
          }
        }
        const updated = await transaction.run.findUniqueOrThrow({
          where: { id: run.id },
          include: { stages: true, jobs: { where: { state: 'queued' }, orderBy: { availableAt: 'asc' }, take: 1 } },
        });
        return toWorkflowRun(updated);
      });
    } catch (error) {
      if (error instanceof WorkflowTransitionError) throw new WorkflowConflictError(error.message);
      if (!isPrismaUniqueConflict(error)) throw error;
      const run = await this.prisma.run.findUnique({ where: { id: input.runId }, include: { stages: true } });
      const existing = await this.prisma.review.findUnique({
        where: { runId_packageChecksum: { runId: input.runId, packageChecksum: input.packageChecksum } },
      });
      if (!run || !existing) throw error;
      resolveExistingReview(existing, { ...toRecordReviewInput(run, input), revision: existing.revision });
      return toWorkflowRun(run);
    }
  }

  async recordPackageChange(input: RecordPackageChangeInput): Promise<WorkflowRun> {
    return this.prisma.$transaction(async (transaction) => {
      await lockRun(transaction, input.runId);
      const run = await transaction.run.findUnique({ where: { id: input.runId }, include: { stages: true } });
      if (!run) throw new WorkflowNotFoundError('Run not found');
      if (run.packageChecksum === input.packageChecksum) return toWorkflowRun(run);
      const stage = run.stages.find((candidate) => candidate.name === run.currentStage);
      if (!stage) throw new WorkflowConflictError('Current stage does not exist');
      const transition = nextTransition({
        stage: run.currentStage as WorkflowStage,
        state: stage.state as StageState,
        revisionAttempts: stage.revisionAttempt,
        packageChecksum: run.packageChecksum as `${string}` | null,
        approvedChecksum: run.approvedChecksum as `${string}` | null,
        reason: stage.reason ?? undefined,
      }, { type: 'package_changed', packageChecksum: input.packageChecksum as `${string}` });
      await transaction.stage.upsert({
        where: { runId_name: { runId: run.id, name: transition.stage } },
        update: { state: transition.state, reason: transition.reason ?? null, revisionAttempt: transition.revisionAttempts },
        create: { runId: run.id, name: transition.stage, state: transition.state, reason: transition.reason ?? null, revisionAttempt: transition.revisionAttempts },
      });
      const updated = await transaction.run.update({
        where: { id: run.id },
        data: {
          currentStage: transition.stage,
          packageChecksum: transition.packageChecksum,
          approvedChecksum: transition.approvedChecksum,
          reviewStatus: reviewStatusForTransition(run.reviewStatus as ReviewStatus, transition),
        },
        include: { stages: true, jobs: { where: { state: 'queued' }, orderBy: { availableAt: 'asc' }, take: 1 } },
      });
      await supersedeDeliveryJobs(transaction, run.id, input.packageChecksum);
      return toWorkflowRun(updated);
    });
  }

  async recordPackageVersion(input: RecordPackageVersionInput): Promise<WorkflowPackageVersion> {
    assertPackageVersionChecksum(input);
    return this.prisma.$transaction(async (transaction) => {
      await lockRun(transaction, input.runId);
      const run = await transaction.run.findUnique({ where: { id: input.runId }, include: { stages: true } });
      if (!run) throw new WorkflowNotFoundError('Run not found');
      if (run.currentRevision !== input.revision) {
        throw new WorkflowConflictError('Package version revision must match the current run revision');
      }
      const where = {
        runId_revision_packageChecksum: {
          runId: input.runId,
          revision: input.revision,
          packageChecksum: input.packageChecksum,
        },
      };
      const data = {
        id: input.id,
        runId: input.runId,
        revision: input.revision,
        packageChecksum: input.packageChecksum,
        adapterVersion: input.adapterVersion,
        locale: input.locale,
        owner: input.owner,
        usageRights: toPrismaJson(input.usageRights),
        content: toPrismaJson(input.content as unknown as JsonObject),
        evidence: toPrismaJson(input.evidence as unknown as JsonObject),
        qa: toPrismaJson(input.qa as unknown as JsonObject),
        artifactInventory: input.artifactInventory as unknown as Prisma.InputJsonValue,
      };
      const existing = await transaction.packageVersion.findUnique({ where });
      const version = existing
        ? resolveExistingPackageVersion(toWorkflowPackageVersion(existing), input)
        : toWorkflowPackageVersion(await transaction.packageVersion.create({ data }));

      if (run.packageChecksum !== input.packageChecksum) {
        const stage = run.stages.find((candidate) => candidate.name === run.currentStage);
        if (!stage) throw new WorkflowConflictError('Current stage does not exist');
        const transition = nextTransition({
          stage: run.currentStage as WorkflowStage,
          state: stage.state as StageState,
          revisionAttempts: stage.revisionAttempt,
          packageChecksum: run.packageChecksum as `${string}` | null,
          approvedChecksum: run.approvedChecksum as `${string}` | null,
          reason: stage.reason ?? undefined,
        }, { type: 'package_changed', packageChecksum: input.packageChecksum as `${string}` });
        await transaction.stage.upsert({
          where: { runId_name: { runId: run.id, name: transition.stage } },
          update: { state: transition.state, reason: transition.reason ?? null, revisionAttempt: transition.revisionAttempts },
          create: { runId: run.id, name: transition.stage, state: transition.state, reason: transition.reason ?? null, revisionAttempt: transition.revisionAttempts },
        });
        await transaction.run.update({
          where: { id: run.id },
          data: {
            currentStage: transition.stage,
            packageChecksum: transition.packageChecksum,
            approvedChecksum: transition.approvedChecksum,
            reviewStatus: reviewStatusForTransition(run.reviewStatus as ReviewStatus, transition),
          },
        });
        await supersedeDeliveryJobs(transaction, run.id, input.packageChecksum);
      }
      return version;
    });
  }
}

export interface InMemoryWorkflowStoreOptions {
  clock?: () => Date;
  idGenerator?: () => string;
}

export function createInMemoryWorkflowStore(
  options: InMemoryWorkflowStoreOptions = {},
): WorkflowStore {
  return new InMemoryWorkflowStore(options);
}

class InMemoryWorkflowStore implements WorkflowStore {
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly runsByNotebookLmNotebookId = new Map<string, string>();
  private readonly jobs = new Map<string, WorkflowJob>();
  private readonly jobsByIdempotencyKey = new Map<string, string>();
  private readonly artifactsById = new Map<string, WorkflowArtifact>();
  private readonly artifactsByStorageKey = new Map<string, WorkflowArtifact>();
  private readonly reviewsByIdentity = new Map<string, WorkflowReview>();
  private readonly packageVersionsByIdentity = new Map<string, WorkflowPackageVersion>();
  private readonly deliveriesByIdempotencyKey = new Map<string, WorkflowDelivery>();
  private readonly effectsByKey = new Map<string, { runId: string; jobId: string; type: string; payload: JsonObject }>();
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;

  constructor(options: InMemoryWorkflowStoreOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? randomUUID;
  }

  async createRun(input: CreateRunInput): Promise<WorkflowRun> {
    const now = this.clock();
    const stages = input.stages ?? [{ name: input.currentStage ?? 'research', state: 'queued' as const }];
    const run: WorkflowRun = {
      id: input.id ?? this.idGenerator(),
      title: input.title,
      locale: input.locale,
      brief: input.brief,
      ...(input.notebookLmNotebookId ? { notebookLmNotebookId: input.notebookLmNotebookId } : {}),
      currentStage: input.currentStage ?? 'research',
      currentRevision: input.currentRevision ?? 1,
      packageChecksum: input.packageChecksum ?? null,
      approvedChecksum: input.approvedChecksum ?? null,
      reviewStatus: input.reviewStatus ?? 'pending',
      stages: toStageMap(stages),
      nextRetryAt: null,
      createdAt: now,
      updatedAt: now,
    };
    if (this.runs.has(run.id)) throw new WorkflowConflictError('Run already exists');
    this.assertNotebookLmNotebookIdAvailable(run.notebookLmNotebookId, run.id);
    this.runs.set(run.id, run);
    if (run.notebookLmNotebookId) this.runsByNotebookLmNotebookId.set(run.notebookLmNotebookId, run.id);
    return run;
  }

  async bootstrapRun(input: BootstrapRunInput): Promise<WorkflowRun> {
    const now = this.clock();
    const runId = input.id ?? this.idGenerator();
    const initialJobKey = initialJobIdempotencyKey(runId);
    if (this.runs.has(runId) || this.jobsByIdempotencyKey.has(initialJobKey)) {
      throw new WorkflowConflictError('Run or initial job already exists');
    }
    const run: WorkflowRun = {
      id: runId,
      title: input.title,
      locale: input.locale,
      brief: input.brief,
      ...(input.notebookLmNotebookId ? { notebookLmNotebookId: input.notebookLmNotebookId } : {}),
      currentStage: 'research',
      currentRevision: 1,
      packageChecksum: null,
      approvedChecksum: null,
      reviewStatus: 'pending',
      stages: toStageMap(BOOTSTRAP_STAGES.map((name) => ({ name, state: 'queued' }))),
      nextRetryAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.assertNotebookLmNotebookIdAvailable(run.notebookLmNotebookId, run.id);
    const job: WorkflowJob = {
      id: this.idGenerator(),
      runId,
      stage: 'research',
      action: ACTION_BY_STAGE.research,
      state: 'queued',
      idempotencyKey: initialJobKey,
      availableAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      executionDeadlineAt: null,
      attempt: 0,
      input: {
        brief: input.brief,
        ...(input.notebookLmNotebookId ? { notebookLmNotebookId: input.notebookLmNotebookId } : {}),
      },
      result: null,
      completionReceipt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(run.id, run);
    if (run.notebookLmNotebookId) this.runsByNotebookLmNotebookId.set(run.notebookLmNotebookId, run.id);
    this.jobs.set(job.id, job);
    this.jobsByIdempotencyKey.set(job.idempotencyKey, job.id);
    return run;
  }

  async getRun(id: string): Promise<WorkflowRun | null> {
    const run = this.runs.get(id);
    if (!run) return null;
    return { ...run, nextRetryAt: this.nextRetryAt(run) };
  }

  async listRuns(): Promise<WorkflowRun[]> {
    return [...this.runs.values()]
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime() || left.id.localeCompare(right.id))
      .map((run) => ({ ...run, nextRetryAt: this.nextRetryAt(run) }));
  }

  private assertNotebookLmNotebookIdAvailable(notebookId: string | undefined, runId: string): void {
    if (!notebookId) return;
    const existingRunId = this.runsByNotebookLmNotebookId.get(notebookId);
    if (existingRunId && existingRunId !== runId) {
      throw new WorkflowConflictError(`NotebookLM notebook ${notebookId} is already assigned to run ${existingRunId}`);
    }
  }

  async listArtifacts(runId: string, revision: number): Promise<WorkflowArtifact[]> {
    return [...this.artifactsById.values()]
      .filter((artifact) => artifact.runId === runId && artifact.revision === revision)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id));
  }

  async listArtifactsByIds(runId: string, artifactIds: readonly string[]): Promise<WorkflowArtifact[]> {
    const requestedIds = new Set(artifactIds);
    if (!requestedIds.size) return [];
    return [...this.artifactsById.values()]
      .filter((artifact) => artifact.runId === runId && requestedIds.has(artifact.id))
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id));
  }

  async listArtifactsForSuccessfulStageJobs(runId: string, revision: number): Promise<WorkflowArtifact[]> {
    const selectedJobIds = new Map<WorkflowStage, string>();
    const jobs = [...this.jobs.values()]
      .filter((job) => job.runId === runId
        && job.state === 'done'
        && [...this.artifactsById.values()].some((artifact) => (
          artifact.jobId === job.id && artifact.revision <= revision
        )))
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime() || right.id.localeCompare(left.id));
    for (const job of jobs) {
      if (!selectedJobIds.has(job.stage)) selectedJobIds.set(job.stage, job.id);
    }
    const successfulJobIds = new Set(jobs.map((job) => job.id));
    const selectedMediaJobIds = new Set(latestReviewMediaArtifacts([...this.artifactsById.values()]
      .filter((artifact) => artifact.runId === runId
        && artifact.revision <= revision
        && artifact.jobId !== null
        && REVIEW_MEDIA_ARTIFACT_KINDS.has(artifact.kind)
        && successfulJobIds.has(artifact.jobId))
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id)))
      .flatMap((artifact) => artifact.jobId ? [artifact.jobId] : []));
    const artifacts = [...this.artifactsById.values()]
      .filter((artifact) => artifact.runId === runId
        && artifact.revision <= revision
        && artifact.jobId !== null
        && (selectedJobIds.get(artifact.stage as WorkflowStage) === artifact.jobId
          || selectedMediaJobIds.has(artifact.jobId)))
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id));
    return latestReviewMediaArtifacts(artifacts);
  }

  async getArtifact(runId: string, artifactId: string): Promise<WorkflowArtifact | null> {
    const artifact = this.artifactsById.get(artifactId);
    return artifact?.runId === runId ? artifact : null;
  }

  async getReview(runId: string, packageChecksum: string): Promise<WorkflowReview | null> {
    return this.reviewsByIdentity.get(`${runId}:${packageChecksum}`) ?? null;
  }

  async getPackageVersion(runId: string, packageChecksum: string): Promise<WorkflowPackageVersion | null> {
    return [...this.packageVersionsByIdentity.values()]
      .filter((version) => version.runId === runId && version.packageChecksum === packageChecksum)
      .sort((left, right) => right.revision - left.revision || right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
  }

  async getPackageVersionById(id: string): Promise<WorkflowPackageVersion | null> {
    return [...this.packageVersionsByIdentity.values()].find((version) => version.id === id) ?? null;
  }

  async getDelivery(id: string): Promise<WorkflowDelivery | null> {
    return [...this.deliveriesByIdempotencyKey.values()].find((delivery) => delivery.id === id) ?? null;
  }

  async getDeliveryForPackage(runId: string, packageChecksum: string): Promise<WorkflowDelivery | null> {
    return [...this.deliveriesByIdempotencyKey.values()].find((delivery) => (
      delivery.runId === runId && delivery.packageChecksum === packageChecksum
    )) ?? null;
  }

  async getJobContext(jobId: string): Promise<WorkflowJobContext | null> {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const run = this.requireRun(job.runId);
    const stage = run.stages[job.stage];
    if (!stage) throw new WorkflowConflictError('Current stage does not exist');
    return {
      job,
      run: { ...run, nextRetryAt: this.nextRetryAt(run) },
      stage,
      packageChecksum: run.packageChecksum,
      approvedChecksum: run.approvedChecksum,
    };
  }

  async queueJob(input: QueueJobInput): Promise<WorkflowJob> {
    this.requireRun(input.runId);
    const existingId = this.jobsByIdempotencyKey.get(input.idempotencyKey);
    if (existingId) return this.jobs.get(existingId)!;

    const now = this.clock();
    const job: WorkflowJob = {
      id: input.id ?? this.idGenerator(),
      runId: input.runId,
      stage: input.stage,
      action: input.action,
      state: 'queued',
      idempotencyKey: input.idempotencyKey,
      availableAt: input.availableAt ?? now,
      leaseOwner: null,
      leaseExpiresAt: null,
      executionDeadlineAt: null,
      attempt: 0,
      input: input.input,
      result: null,
      completionReceipt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    this.jobsByIdempotencyKey.set(job.idempotencyKey, job.id);
    return job;
  }

  async retryStage(input: RetryStageInput): Promise<WorkflowRun> {
    const run = this.requireRun(input.runId);
    if (run.currentStage !== input.stage) throw new WorkflowConflictError('Only the current stage can be retried');
    const stage = run.stages[input.stage];
    if (!stage || stage.state !== 'needs_human') {
      throw new WorkflowConflictError('Only a stage needing human intervention can be retried');
    }
    const previousJob = [...this.jobs.values()]
      .filter((job) => job.runId === input.runId && job.stage === input.stage && job.state === 'needs_human')
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0];
    if (!previousJob) throw new WorkflowConflictError('No completed worker action is available to retry');
    const retryDependencies = isLegacyMediaReconciliationInput(previousJob.input)
      ? currentReconciliationDependencies(this.artifactsById.values(), input.runId, run.currentRevision)
      : [];
    const now = this.clock();
    stage.state = 'queued';
    stage.reason = null;
    run.updatedAt = now;
    const job: WorkflowJob = {
      id: this.idGenerator(),
      runId: input.runId,
      stage: input.stage,
      action: previousJob.action,
      state: 'queued',
      idempotencyKey: `workflow:${input.runId}:${input.stage}:manual-retry:${this.idGenerator()}`,
      availableAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      executionDeadlineAt: null,
      attempt: 0,
      input: {
        ...previousJob.input,
        ...(retryDependencies.length > 0 ? { dependencies: retryDependencies } : {}),
        ...(run.notebookLmNotebookId ? { notebookLmNotebookId: run.notebookLmNotebookId } : {}),
      },
      result: null,
      completionReceipt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    this.jobsByIdempotencyKey.set(job.idempotencyKey, job.id);
    return { ...run, nextRetryAt: this.nextRetryAt(run) };
  }

  async refreshResearch(input: RefreshResearchInput): Promise<WorkflowRun> {
    const run = this.requireRun(input.runId);
    assertResearchRefreshAllowed({
      currentStage: run.currentStage,
      reviewStatus: run.reviewStatus,
      approvedChecksum: run.approvedChecksum,
      createState: run.stages.create?.state,
    });
    const notebookLmNotebookId = run.notebookLmNotebookId ?? notebookIdFromBrief(input.brief);
    assertResearchRefreshBrief(input.brief, notebookLmNotebookId);
    if ([...this.jobs.values()].some((job) => (
      job.runId === input.runId && (job.state === 'queued' || job.state === 'running')
    ))) {
      throw new WorkflowConflictError('Research refresh requires no active worker jobs');
    }
    const now = this.clock();
    const research = run.stages.research;
    const create = run.stages.create;
    if (!research || !create) throw new WorkflowConflictError('Research refresh requires Research and Create stages');
    run.brief = input.brief;
    run.currentStage = 'research';
    run.currentRevision += 1;
    run.packageChecksum = null;
    run.updatedAt = now;
    research.state = 'queued';
    research.reason = null;
    create.state = 'queued';
    create.reason = null;
    const job: WorkflowJob = {
      id: this.idGenerator(),
      runId: input.runId,
      stage: 'research',
      action: ACTION_BY_STAGE.research,
      state: 'queued',
      idempotencyKey: `workflow:${input.runId}:research:refresh:${this.idGenerator()}`,
      availableAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      executionDeadlineAt: null,
      attempt: 0,
      input: {
        brief: input.brief,
        ...(notebookLmNotebookId ? { notebookLmNotebookId } : {}),
        researchRefresh: { requestedBy: input.operatorId },
      },
      result: null,
      completionReceipt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    this.jobsByIdempotencyKey.set(job.idempotencyKey, job.id);
    return { ...run, nextRetryAt: this.nextRetryAt(run) };
  }

  async queueLegacyAudioReconciliation(runId: string): Promise<WorkflowRun> {
    const run = this.requireRun(runId);
    const reviewStage = run.stages.human_review;
    if (run.currentStage !== 'human_review' || reviewStage?.state !== 'needs_human') {
      throw new WorkflowConflictError('Legacy audio reconciliation requires a pending human review stage');
    }
    assertLegacyAudioReuse(run.brief);
    if ([...this.jobs.values()].some((job) => (
      job.runId === runId && (job.state === 'queued' || job.state === 'running')
    ))) {
      throw new WorkflowConflictError('The run already has active pipeline work');
    }
    const transition = nextTransition({
      stage: 'human_review',
      state: 'needs_human',
      revisionAttempts: reviewStage.revisionAttempts,
      packageChecksum: run.packageChecksum as `${string}` | null,
      approvedChecksum: run.approvedChecksum as `${string}` | null,
      reason: reviewStage.reason ?? undefined,
    }, {
      type: 'media_reconciliation_requested',
      reason: 'Attach the existing Brief and Discussion audio files; do not generate audio.',
    });
    let packageVersion = run.packageChecksum
      ? [...this.packageVersionsByIdentity.values()]
        .filter((candidate) => candidate.runId === runId && candidate.packageChecksum === run.packageChecksum)
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0]
      : undefined;
    packageVersion ??= [...this.packageVersionsByIdentity.values()]
      .filter((candidate) => candidate.runId === runId)
      .sort((left, right) => (
        right.revision - left.revision || right.createdAt.getTime() - left.createdAt.getTime()
      ))[0];
    const dependencies = packageVersion?.artifactInventory.flatMap((reference) => {
      const artifact = this.artifactsById.get(reference.artifactId);
      return artifact ? [toJobArtifactDependency(artifact)] : [];
    }) ?? currentReconciliationDependencies(this.artifactsById.values(), runId, run.currentRevision);
    const now = this.clock();
    reviewStage.state = 'done';
    reviewStage.reason = null;
    run.currentStage = 'produce_assets';
    run.stages.produce_assets = {
      name: 'produce_assets',
      state: 'queued',
      reason: transition.reason ?? null,
      attempt: 0,
      revisionAttempts: transition.revisionAttempts,
    };
    run.packageChecksum = transition.packageChecksum;
    run.approvedChecksum = null;
    run.reviewStatus = 'pending';
    run.updatedAt = now;
    const job: WorkflowJob = {
      id: this.idGenerator(),
      runId,
      stage: 'produce_assets',
      action: ACTION_BY_STAGE.produce_assets,
      state: 'queued',
      idempotencyKey: legacyAudioReconciliationJobIdempotencyKey(runId, run.currentRevision),
      availableAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      executionDeadlineAt: null,
      attempt: 0,
      input: {
        brief: run.brief,
        ...(run.notebookLmNotebookId ? { notebookLmNotebookId: run.notebookLmNotebookId } : {}),
        mediaOperation: 'attach_existing',
        mediaKinds: ['audio_brief', 'audio_discussion'],
        dependencies,
      },
      result: null,
      completionReceipt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    this.jobsByIdempotencyKey.set(job.idempotencyKey, job.id);
    this.effectsByKey.set(`reconciliation:${runId}:${run.currentRevision}`, {
      runId,
      jobId: job.id,
      type: 'queue_stage',
      payload: { type: 'queue_stage', stage: 'produce_assets' },
    });
    return { ...run, nextRetryAt: this.nextRetryAt(run) };
  }

  async queueMediaRegeneration(
    runId: string,
    kinds: readonly RegenerableMediaKind[],
    recipeOverrides?: MediaRecipeOverrides,
  ): Promise<WorkflowRun> {
    assertRegenerableMediaKinds(kinds);
    if (recipeOverrides?.heroMode === 'deferred' && kinds.includes('hero')) {
      throw new WorkflowValidationError('Deferred hero mode cannot regenerate the hero asset');
    }
    const run = this.requireRun(runId);
    const reviewStage = run.stages.human_review;
    const pendingReview = run.currentStage === 'human_review' && reviewStage?.state === 'needs_human';
    const approvedBeforeDelivery = run.currentStage === 'deliver' && run.reviewStatus === 'approved';
    if (!pendingReview && !approvedBeforeDelivery) {
      throw new WorkflowConflictError('Media regeneration requires pending review or approval awaiting delivery');
    }
    const activeJobs = [...this.jobs.values()].filter((job) => (
      job.runId === runId && (job.state === 'queued' || job.state === 'running')
    ));
    if (activeJobs.some((job) => job.state === 'running' || job.stage !== 'deliver')) {
      throw new WorkflowConflictError('The run already has active pipeline work');
    }
    const currentPackageVersion = run.packageChecksum
      ? [...this.packageVersionsByIdentity.values()]
        .filter((candidate) => candidate.runId === runId && candidate.packageChecksum === run.packageChecksum)
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0]
      : undefined;
    const packageVersion = currentPackageVersion ?? [...this.packageVersionsByIdentity.values()]
      .filter((candidate) => candidate.runId === runId)
      .sort((left, right) => (
        right.revision - left.revision || right.createdAt.getTime() - left.createdAt.getTime()
      ))[0];
    const dependencies = packageVersion?.artifactInventory.flatMap((reference) => {
      const artifact = this.artifactsById.get(reference.artifactId);
      return artifact ? [toJobArtifactDependency(artifact)] : [];
    }) ?? currentReconciliationDependencies(this.artifactsById.values(), runId, run.currentRevision);
    if (!dependencies.length) throw new WorkflowConflictError('Media regeneration requires current content artifacts');
    const regenerationBrief = briefWithMediaRegenerationSource(
      briefWithMediaRecipeOverrides(run.brief, recipeOverrides),
      packageVersion?.packageChecksum,
      kinds,
    );
    const now = this.clock();
    if (approvedBeforeDelivery) {
      for (const job of activeJobs) {
        job.state = 'superseded';
        job.leaseOwner = null;
        job.leaseExpiresAt = null;
        job.executionDeadlineAt = null;
        job.updatedAt = now;
      }
      for (const delivery of this.deliveriesByIdempotencyKey.values()) {
        if (delivery.runId === runId && ['queued', 'waiting', 'failed'].includes(delivery.state)) {
          delivery.state = 'superseded';
          delivery.nextAttemptAt = null;
          delivery.updatedAt = now;
        }
      }
    }
    run.stages.human_review = {
      name: 'human_review',
      state: 'done',
      reason: null,
      attempt: reviewStage?.attempt ?? 0,
      revisionAttempts: reviewStage?.revisionAttempts ?? 0,
    };
    run.currentStage = 'produce_assets';
    run.brief = regenerationBrief;
    run.stages.produce_assets = {
      name: 'produce_assets',
      state: 'queued',
      reason: `Regenerate ${kinds.join(', ')}`,
      attempt: 0,
      revisionAttempts: 0,
    };
    run.packageChecksum = null;
    run.approvedChecksum = null;
    run.reviewStatus = 'pending';
    run.updatedAt = now;
    const job: WorkflowJob = {
      id: this.idGenerator(),
      runId,
      stage: 'produce_assets',
      action: ACTION_BY_STAGE.produce_assets,
      state: 'queued',
      idempotencyKey: `workflow:${runId}:produce_assets:media-regeneration:${run.currentRevision}:${this.idGenerator()}`,
      availableAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      executionDeadlineAt: null,
      attempt: 0,
      input: {
        brief: regenerationBrief,
        ...(run.notebookLmNotebookId ? { notebookLmNotebookId: run.notebookLmNotebookId } : {}),
        mediaOperation: 'generate',
        mediaKinds: [...kinds],
        dependencies,
      },
      result: null,
      completionReceipt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    this.jobsByIdempotencyKey.set(job.idempotencyKey, job.id);
    return { ...run, nextRetryAt: this.nextRetryAt(run) };
  }

  async prepareLegacyRevision(input: PrepareLegacyRevisionInput): Promise<PrepareLegacyRevisionResult> {
    assertStrictLegacyReplacement(input);
    const run = this.requireRun(input.runId);
    const operation = legacyRevisionOperation(input);
    const existingEffect = this.effectsByKey.get(operation.effectKey);
    if (existingEffect) {
      assertLegacyRevisionReplay(existingEffect.payload, operation.payload);
      if (run.currentRevision !== input.expectedRevision + 1
        || run.currentStage !== 'research'
        || run.packageChecksum !== null
        || run.approvedChecksum !== null
        || run.reviewStatus !== 'pending'
        || legacyBriefChecksum(run.brief) !== operation.replacementBriefChecksum) {
        throw new WorkflowConflictError('Legacy revision preparation replay does not match the prepared run');
      }
      return {
        run: { ...run, nextRetryAt: this.nextRetryAt(run) },
        previousRevision: input.expectedRevision,
        previousPackageChecksum: input.expectedPackageChecksum,
      };
    }
    assertLegacyRevisionFence(run, input);
    const now = this.clock();
    for (const job of this.jobs.values()) {
      if (job.runId === run.id && (job.state === 'queued' || job.state === 'running')) {
        job.state = 'superseded';
        job.leaseOwner = null;
        job.leaseExpiresAt = null;
        job.executionDeadlineAt = null;
        job.updatedAt = now;
      }
    }
    for (const stage of WORKFLOW_STAGES) {
      const snapshot = run.stages[stage] ?? {
        name: stage,
        state: 'queued',
        reason: null,
        attempt: 0,
        revisionAttempts: 0,
      };
      snapshot.state = 'queued';
      snapshot.reason = null;
      snapshot.attempt = 0;
      snapshot.revisionAttempts = 0;
      run.stages[stage] = snapshot;
    }
    run.brief = input.brief;
    run.currentStage = 'research';
    run.currentRevision += 1;
    run.packageChecksum = null;
    run.approvedChecksum = null;
    run.reviewStatus = 'pending';
    run.updatedAt = now;
    await this.queueJob({
      runId: run.id,
      stage: 'research',
      action: ACTION_BY_STAGE.research,
      idempotencyKey: transitionJobIdempotencyKey(run.id, 'research', run.currentRevision),
      input: { brief: input.brief, notebookLmNotebookId: input.notebookLmNotebookId },
      availableAt: now,
    });
    this.effectsByKey.set(operation.effectKey, {
      runId: run.id,
      jobId: `legacy-revision:${input.expectedRevision}`,
      type: 'prepare_legacy_revision',
      payload: operation.payload,
    });
    return {
      run: { ...run, nextRetryAt: this.nextRetryAt(run) },
      previousRevision: input.expectedRevision,
      previousPackageChecksum: input.expectedPackageChecksum,
    };
  }

  async claimJob(input: ClaimJobInput): Promise<JobClaim | null> {
    assertWorkerId(input.workerId);
    assertLeaseSeconds(input.leaseSeconds);
    assertExecutionSeconds(input.executionSeconds);
    assertCapabilities(input.capabilities);
    const claimedAt = input.now ?? this.clock();
    const job = [...this.jobs.values()]
      .filter((candidate) => candidate.state === 'queued'
        && candidate.availableAt <= claimedAt
        && (!input.preferredRunId || candidate.runId === input.preferredRunId)
        && this.requireRun(candidate.runId).currentStage === candidate.stage
        && (candidate.stage !== 'deliver'
          || (this.requireRun(candidate.runId).approvedChecksum !== null
            && candidate.input.packageChecksum === this.requireRun(candidate.runId).approvedChecksum))
        && (!input.capabilities?.length || input.capabilities.includes(candidate.action)))
      .sort((left, right) => stageCompletionRank(right.stage) - stageCompletionRank(left.stage)
        || left.availableAt.getTime() - right.availableAt.getTime()
        || left.createdAt.getTime() - right.createdAt.getTime())[0];

    if (!job) return null;

    job.state = 'running';
    job.leaseOwner = input.workerId;
    job.leaseExpiresAt = new Date(claimedAt.getTime() + input.leaseSeconds * 1_000);
    const executionSeconds = input.executionSeconds
      ?? (job.action === 'create_content'
        ? CREATE_CONTENT_JOB_EXECUTION_SECONDS
        : job.action === 'produce_assets'
          ? PRODUCE_ASSETS_JOB_EXECUTION_SECONDS
          : DEFAULT_JOB_EXECUTION_SECONDS);
    job.executionDeadlineAt = new Date(claimedAt.getTime() + executionSeconds * 1_000);
    job.attempt += 1;
    job.updatedAt = claimedAt;
    const run = this.requireRun(job.runId);
    const stage = run.stages[job.stage];
    if (!stage) throw new WorkflowConflictError('Current stage does not exist');
    stage.state = 'running';
    stage.reason = null;
    stage.attempt = job.attempt;
    run.updatedAt = claimedAt;

    return {
      jobId: job.id,
      packageId: job.runId,
      stage: job.stage,
      claimedBy: input.workerId,
      claimedAt: claimedAt.toISOString(),
      leaseExpiresAt: job.leaseExpiresAt.toISOString(),
      executionDeadlineAt: job.executionDeadlineAt.toISOString(),
      attempt: job.attempt,
      revision: run.currentRevision,
      input: job.input,
      ...(job.stage === 'deliver' ? deliveryClaimIdentity(job.input) : {}),
    };
  }

  async renewJobLease(input: RenewJobLeaseInput): Promise<void> {
    const job = this.jobs.get(input.jobId);
    const now = this.clock();
    const run = job ? this.runs.get(job.runId) : undefined;
    if (
      !job
      || !run
      || job.state !== 'running'
      || job.leaseOwner !== input.workerId
      || !job.leaseExpiresAt
      || job.leaseExpiresAt <= now
      || !job.executionDeadlineAt
      || job.executionDeadlineAt <= now
      || run.currentStage !== job.stage
    ) {
      throw new WorkflowConflictError('Job lease is no longer valid');
    }

    const leaseDuration = job.leaseExpiresAt.getTime() - job.updatedAt.getTime();
    if (leaseDuration <= 0) throw new WorkflowConflictError('Job lease is no longer valid');
    job.leaseExpiresAt = new Date(now.getTime() + leaseDuration);
    job.updatedAt = now;
  }

  async completeJob(input: CompleteJobInput): Promise<JobResult> {
    const completedAt = this.clock();
    const job = this.jobs.get(input.result.jobId);
    if (
      !job
      || job.runId !== input.result.packageId
      || job.stage !== input.result.stage
      || job.state !== 'running'
      || job.leaseOwner !== input.workerId
      || !job.leaseExpiresAt
      || job.leaseExpiresAt <= completedAt
    ) {
      throw new WorkflowConflictError('Job lease is no longer valid');
    }

    job.state = input.result.state;
    job.result = input.result;
    job.leaseOwner = null;
    job.leaseExpiresAt = null;
    job.executionDeadlineAt = null;
    job.updatedAt = completedAt;
    return input.result;
  }

  async hasActiveJobLease(input: HasActiveJobLeaseInput): Promise<boolean> {
    const job = this.jobs.get(input.jobId);
    const now = input.now ?? this.clock();
    return Boolean(
      job
      && job.runId === input.runId
      && job.state === 'running'
      && job.leaseOwner === input.workerId
      && job.leaseExpiresAt
      && job.leaseExpiresAt > now,
    );
  }

  async hasActiveArtifactLease(input: HasActiveArtifactLeaseInput): Promise<boolean> {
    return this.isActiveArtifactLease(input);
  }

  private isActiveArtifactLease(input: HasActiveArtifactLeaseInput): boolean {
    const job = this.jobs.get(input.jobId);
    const run = job ? this.runs.get(job.runId) : undefined;
    const now = input.now ?? this.clock();
    return Boolean(
      job
      && run
      && job.runId === input.runId
      && job.state === 'running'
      && job.leaseOwner === input.workerId
      && job.leaseExpiresAt
      && job.leaseExpiresAt > now
      && run.currentRevision === input.revision
      && isArtifactKindAuthorizedForJob(input.kind, job),
    );
  }

  async applyJobResult(input: ApplyJobResultInput): Promise<WorkflowRun> {
    const completedAt = this.clock();
    const job = this.jobs.get(input.result.jobId);
    const receiptInput = completionReceiptInput(input);
    if (job?.completionReceipt) return replayCompletionReceipt(job.completionReceipt, receiptInput);
    assertRetryAtInFuture(input.retryAt, completedAt);
    const transition = input.transition;
    if (!transition) throw new WorkflowConflictError('A new job result requires a transition');
    if (
      !job
      || job.runId !== input.result.packageId
      || job.stage !== input.result.stage
      || job.state !== 'running'
      || job.leaseOwner !== input.workerId
      || !job.leaseExpiresAt
      || job.leaseExpiresAt <= completedAt
    ) {
      throw new WorkflowConflictError('Job lease is no longer valid');
    }
    const run = this.requireRun(job.runId);
    if (run.currentStage !== job.stage) throw new WorkflowConflictError('Job is not for the current stage');
    const currentStage = run.stages[job.stage];
    if (!currentStage) throw new WorkflowConflictError('Current stage does not exist');
    const nextStage = run.stages[transition.stage] ?? {
      name: transition.stage,
      state: transition.state,
      reason: null,
      attempt: 0,
      revisionAttempts: 0,
    };
    run.stages[transition.stage] = nextStage;

    job.state = input.result.state;
    job.result = input.result;
    job.leaseOwner = null;
    job.leaseExpiresAt = null;
    job.executionDeadlineAt = null;
    job.updatedAt = completedAt;
    const completedArtifacts = [...this.artifactsById.values()]
      .filter((artifact) => artifact.jobId === job.id)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id));
    const nextRevision = run.currentRevision
      + Number(transition.revisionAttempts > currentStage.revisionAttempts);
    if (transition.stage !== job.stage) {
      currentStage.state = 'done';
      currentStage.reason = null;
    }
    nextStage.state = transition.state;
    nextStage.reason = transition.reason ?? null;
    nextStage.revisionAttempts = transition.revisionAttempts;
    run.currentStage = transition.stage;
    run.currentRevision = nextRevision;
    run.packageChecksum = transition.packageChecksum;
    run.approvedChecksum = transition.approvedChecksum;
    run.reviewStatus = reviewStatusForTransition(run.reviewStatus, transition);
    run.updatedAt = completedAt;

    for (const [index, effect] of transition.effects.entries()) {
      this.effectsByKey.set(workflowEffectKey(job.id, index), {
        runId: job.runId,
        jobId: job.id,
        type: effect.type,
        payload: effect as unknown as JsonObject,
      });
      if (effect.type === 'queue_stage') {
        if (effect.stage === 'human_review') {
          throw new WorkflowConflictError('Human review cannot be queued as a worker job');
        }
        await this.queueJob({
          runId: run.id,
          stage: effect.stage,
          action: ACTION_BY_STAGE[effect.stage],
          idempotencyKey: transitionJobIdempotencyKey(run.id, effect.stage, nextRevision),
          input: {
            brief: run.brief,
            ...(run.notebookLmNotebookId ? { notebookLmNotebookId: run.notebookLmNotebookId } : {}),
            ...mediaJobInputForStage(run.brief, effect.stage),
            dependencies: nextJobDependencies(job.input, completedArtifacts, effect.stage),
          },
        });
      }
      if (effect.type === 'queue_delivery') {
        const packageVersion = [...this.packageVersionsByIdentity.values()].find((version) => (
          version.runId === run.id
          && version.revision === nextRevision
          && version.packageChecksum === effect.packageChecksum
        ));
        if (!packageVersion) throw new WorkflowConflictError('Delivery requires a persisted immutable package version');
        const deliveryId = this.idGenerator();
        await this.queueJob({
          runId: run.id,
          stage: 'deliver',
          action: ACTION_BY_STAGE.deliver,
          idempotencyKey: deliveryJobIdempotencyKey(run.id, nextRevision, effect.packageChecksum),
          input: {
            brief: run.brief,
            ...(run.notebookLmNotebookId ? { notebookLmNotebookId: run.notebookLmNotebookId } : {}),
            deliveryId,
            packageChecksum: effect.packageChecksum,
            packageVersionId: packageVersion.id,
          },
        });
        await this.recordDelivery({
          id: deliveryId,
          runId: run.id,
          packageVersionId: packageVersion.id,
          target: packageVersion.content.target.kind,
          packageChecksum: effect.packageChecksum,
          idempotencyKey: externalDeliveryIdempotencyKey(packageVersion.id, effect.packageChecksum),
          state: 'queued',
        });
      }
      if (effect.type === 'request_review') {
        assertDurableEffect(
          transition.stage === 'human_review' && transition.state === 'needs_human',
          'Review request was not represented by the human-review stage',
        );
      }
      if (effect.type === 'request_human') {
        assertDurableEffect(
          transition.state === 'needs_human' && transition.stage !== 'human_review',
          'Human request was not represented by an automated stage',
        );
      }
      if (effect.type === 'record_delivery') {
        assertDurableEffect(
          transition.stage === 'deliver' && transition.state === 'done',
          'Delivery record was not represented by the delivery stage',
        );
      }
    }
    if (input.retryAt) {
      await this.queueJob({
        runId: run.id,
        stage: job.stage,
        action: job.action,
        idempotencyKey: retryJobIdempotencyKey(job.id, job.attempt),
        availableAt: input.retryAt,
        input: job.input,
      });
    }
    const workflowRun = { ...run, nextRetryAt: this.nextRetryAt(run) };
    job.completionReceipt = createCompletionReceipt(receiptInput, workflowRun);
    return workflowRun;
  }

  async releaseExpiredLeases(input: { now?: Date } = {}): Promise<number> {
    const now = input.now ?? this.clock();
    let released = 0;

    for (const job of this.jobs.values()) {
      if (job.state === 'running' && job.leaseExpiresAt && job.leaseExpiresAt <= now) {
        job.state = 'queued';
        job.leaseOwner = null;
        job.leaseExpiresAt = null;
        job.executionDeadlineAt = null;
        job.availableAt = now;
        job.updatedAt = now;
        const run = this.requireRun(job.runId);
        const stage = run.stages[job.stage];
        const hasAnotherActiveJob = [...this.jobs.values()].some((candidate) => candidate.id !== job.id
          && candidate.runId === job.runId
          && candidate.stage === job.stage
          && candidate.state === 'running');
        if (stage?.state === 'running' && !hasAnotherActiveJob) {
          stage.state = 'queued';
          stage.reason = null;
          run.updatedAt = now;
        }
        released += 1;
      }
    }

    return released;
  }

  async recordArtifact(input: RecordArtifactInput): Promise<WorkflowArtifact> {
    this.requireRun(input.runId);
    const artifactId = input.id ?? this.idGenerator();
    if (this.artifactsById.has(artifactId)) {
      throw new WorkflowConflictError('Artifact ID already exists');
    }
    if (this.artifactsByStorageKey.has(input.storageKey)) {
      throw new WorkflowConflictError('Artifact storage key already exists');
    }

    const artifact: WorkflowArtifact = {
      ...input,
      id: artifactId,
      jobId: input.jobId ?? null,
      stage: input.stage ?? null,
      action: input.action ?? null,
      createdAt: this.clock(),
    };
    this.artifactsById.set(artifact.id, artifact);
    this.artifactsByStorageKey.set(artifact.storageKey, artifact);
    return artifact;
  }

  async recordArtifactForActiveLease(input: RecordArtifactForActiveLeaseInput): Promise<WorkflowArtifact> {
    if (!this.isActiveArtifactLease(input)) {
      throw new WorkflowConflictError('Artifact-producing job lease is no longer valid');
    }
    const job = this.jobs.get(input.jobId)!;
    const { jobId: _jobId, workerId: _workerId, ...artifact } = input;
    return this.recordArtifact({
      ...artifact,
      jobId: job.id,
      stage: job.stage,
      action: job.action,
      provenance: {
        ...artifact.provenance,
        jobId: job.id,
        stage: job.stage,
        action: job.action,
      },
    });
  }

  async recordReview(input: RecordReviewInput): Promise<WorkflowReview> {
    this.requireRun(input.runId);
    const identity = reviewIdentity(input);
    const existing = this.reviewsByIdentity.get(identity);
    if (existing) return resolveExistingReview(existing, input);

    const review: WorkflowReview = {
      ...input,
      id: input.id ?? this.idGenerator(),
      createdAt: this.clock(),
    };
    this.reviewsByIdentity.set(identity, review);
    return review;
  }

  async recordDelivery(input: RecordDeliveryInput): Promise<WorkflowDelivery> {
    this.requireRun(input.runId);
    const existing = this.deliveriesByIdempotencyKey.get(input.idempotencyKey);
    if (existing) return existing;

    const now = this.clock();
    const delivery: WorkflowDelivery = {
      id: input.id ?? this.idGenerator(),
      runId: input.runId,
      packageVersionId: input.packageVersionId,
      target: input.target,
      packageChecksum: input.packageChecksum,
      idempotencyKey: input.idempotencyKey,
      state: input.state,
      attempts: 0,
      response: input.response ?? null,
      nextAttemptAt: input.nextAttemptAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.deliveriesByIdempotencyKey.set(delivery.idempotencyKey, delivery);
    return delivery;
  }

  async transitionDeliveryForActiveLease(input: TransitionDeliveryInput): Promise<WorkflowDelivery> {
    const delivery = await this.getDelivery(input.id);
    if (!delivery) throw new WorkflowNotFoundError('Delivery not found');
    const run = this.runs.get(delivery.runId);
    const job = this.jobs.get(input.jobId);
    const review = this.reviewsByIdentity.get(`${delivery.runId}:${input.packageChecksum}`);
    const packageVersion = [...this.packageVersionsByIdentity.values()]
      .find((version) => version.id === input.packageVersionId);
    const now = input.now ?? this.clock();
    const fenceMatches = delivery.state === input.expectedState
      && (input.expectedState !== 'waiting'
        || Boolean(delivery.nextAttemptAt && delivery.nextAttemptAt <= now))
      && delivery.packageVersionId === input.packageVersionId
      && delivery.packageChecksum === input.packageChecksum
      && run?.currentStage === 'deliver'
      && run.packageChecksum === input.packageChecksum
      && run.approvedChecksum === input.packageChecksum
      && review?.decision === 'approve'
      && packageVersion?.runId === delivery.runId
      && packageVersion.revision === run.currentRevision
      && packageVersion.packageChecksum === input.packageChecksum
      && job?.runId === delivery.runId
      && job.stage === 'deliver'
      && job.action === ACTION_BY_STAGE.deliver
      && job.state === 'running'
      && job.leaseOwner === input.workerId
      && Boolean(job.leaseExpiresAt && job.leaseExpiresAt > now)
      && job.input.deliveryId === delivery.id
      && job.input.packageVersionId === input.packageVersionId
      && job.input.packageChecksum === input.packageChecksum;

    if (!fenceMatches) {
      if (input.response !== undefined) {
        delivery.response = mergeLateDeliveryEvidence(delivery.response, input.response);
        delivery.updatedAt = this.clock();
      }
      throw new WorkflowConflictError('Delivery transition fence no longer matches');
    }

    delivery.state = input.state;
    if (input.response !== undefined) delivery.response = mergeDeliveryResponse(delivery.response, input.response);
    if (input.nextAttemptAt !== undefined) delivery.nextAttemptAt = input.nextAttemptAt;
    if (input.incrementAttempts) delivery.attempts += 1;
    delivery.updatedAt = this.clock();
    return delivery;
  }

  async retryDelivery(deliveryId: string): Promise<RetryDeliveryResult> {
    const delivery = await this.getDelivery(deliveryId);
    if (!delivery) throw new WorkflowNotFoundError('Delivery not found');
    const run = this.requireRun(delivery.runId);
    if (!['failed', 'waiting', 'running', 'verifying', 'succeeded', 'needs_human'].includes(delivery.state)) {
      throw new WorkflowConflictError('Delivery state is not recoverable');
    }
    if (run.packageChecksum !== delivery.packageChecksum || run.approvedChecksum !== delivery.packageChecksum) {
      throw new WorkflowConflictError('Delivery checksum no longer matches the current approval');
    }
    const now = this.clock();
    const recoveryJobs = [...this.jobs.values()]
      .filter((job) => job.runId === delivery.runId
        && job.stage === 'deliver'
        && (job.state === 'queued' || job.state === 'running')
        && job.input.deliveryId === delivery.id)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    const active = recoveryJobs.find((job) => (
      job.state === 'running' && job.leaseExpiresAt && job.leaseExpiresAt > now
    ));
    if (active) throw new WorkflowConflictError('Delivery execution has an active lease');
    const nextAttempt = delivery.attempts + 1;
    const queued = recoveryJobs.find((job) => job.state === 'queued');
    const expired = recoveryJobs.find((job) => job.state === 'running');
    if (queued) {
      if (queued.availableAt <= now) throw new WorkflowConflictError('Delivery recovery is already queued');
      queued.availableAt = now;
      queued.updatedAt = now;
      if (expired) {
        expired.state = 'superseded';
        expired.leaseOwner = null;
        expired.leaseExpiresAt = null;
        expired.executionDeadlineAt = null;
        expired.updatedAt = now;
      }
    } else if (expired) {
      expired.state = 'queued';
      expired.leaseOwner = null;
      expired.leaseExpiresAt = null;
      expired.executionDeadlineAt = null;
      expired.availableAt = now;
      expired.updatedAt = now;
    } else {
      await this.queueJob({
        runId: delivery.runId,
        stage: 'deliver',
        action: ACTION_BY_STAGE.deliver,
        idempotencyKey: deliveryRetryJobIdempotencyKey(delivery.id, nextAttempt),
        input: deliveryJobInput(delivery, run.brief),
      });
    }
    const stage = run.stages.deliver;
    if (!stage) throw new WorkflowConflictError('Delivery stage does not exist');
    stage.state = 'queued';
    stage.reason = null;
    if (delivery.state === 'failed' || delivery.state === 'waiting' || delivery.state === 'needs_human') {
      delivery.state = 'waiting';
      delivery.nextAttemptAt = now;
    }
    delivery.updatedAt = now;
    return { delivery, nextAttempt };
  }

  async reviewRun(input: ReviewRunInput): Promise<WorkflowRun> {
    const run = this.requireRun(input.runId);
    const reviewInput = toRecordReviewInput(run, input);
    const identity = reviewIdentity(reviewInput);
    const existing = this.reviewsByIdentity.get(identity);
    if (existing) {
      resolveExistingReview(existing, reviewInput);
      return { ...run, nextRetryAt: this.nextRetryAt(run) };
    }
    if (run.packageChecksum !== input.packageChecksum) {
      throw new WorkflowConflictError('Review checksum must match the current package checksum');
    }
    const packageVersion = [...this.packageVersionsByIdentity.values()].find((version) => (
      version.runId === run.id
      && version.revision === run.currentRevision
      && version.packageChecksum === input.packageChecksum
    ));
    if (!packageVersion) throw new WorkflowConflictError('Review requires a persisted immutable package version');
    const stage = run.stages[run.currentStage];
    if (!stage) throw new WorkflowConflictError('Current stage does not exist');
    const transition = nextTransition({
      stage: run.currentStage,
      state: stage.state,
      revisionAttempts: stage.revisionAttempts,
      packageChecksum: run.packageChecksum as `${string}`,
      approvedChecksum: run.approvedChecksum as `${string}` | null,
      reason: stage.reason ?? undefined,
    }, reviewEvent(input));
    const review: WorkflowReview = {
      ...reviewInput,
      id: this.idGenerator(),
      createdAt: this.clock(),
    };
    this.reviewsByIdentity.set(identity, review);
    if (transition.stage !== run.currentStage) {
      stage.state = 'done';
      stage.reason = null;
    }
    const nextStage = run.stages[transition.stage] ?? {
      name: transition.stage,
      state: transition.state,
      reason: null,
      attempt: 0,
      revisionAttempts: 0,
    };
    run.stages[transition.stage] = nextStage;
    nextStage.state = transition.state;
    nextStage.reason = transition.reason ?? null;
    nextStage.revisionAttempts = transition.revisionAttempts;
    run.currentStage = transition.stage;
    run.currentRevision += Number(input.decision === 'request_changes');
    run.packageChecksum = transition.packageChecksum;
    run.approvedChecksum = transition.approvedChecksum;
    run.reviewStatus = reviewStatusForDecision(input.decision);
    run.updatedAt = this.clock();

    for (const [index, effect] of transition.effects.entries()) {
      this.effectsByKey.set(`review:${review.id}:effect:${index}`, {
        runId: run.id,
        jobId: `review:${review.id}`,
        type: effect.type,
        payload: effect as unknown as JsonObject,
      });
      if (effect.type === 'queue_delivery') {
        const deliveryId = this.idGenerator();
        await this.queueJob({
          runId: run.id,
          stage: 'deliver',
          action: ACTION_BY_STAGE.deliver,
          idempotencyKey: deliveryJobIdempotencyKey(run.id, run.currentRevision, effect.packageChecksum),
          input: {
            brief: run.brief,
            ...(run.notebookLmNotebookId ? { notebookLmNotebookId: run.notebookLmNotebookId } : {}),
            deliveryId,
            packageChecksum: effect.packageChecksum,
            packageVersionId: packageVersion.id,
          },
        });
        await this.recordDelivery({
          id: deliveryId,
          runId: run.id,
          packageVersionId: packageVersion.id,
          target: packageVersion.content.target.kind,
          packageChecksum: effect.packageChecksum,
          idempotencyKey: externalDeliveryIdempotencyKey(packageVersion.id, effect.packageChecksum),
          state: 'queued',
        });
      }
      if (effect.type === 'queue_stage') {
        if (effect.stage === 'human_review') {
          throw new WorkflowConflictError('Human review cannot be queued as a worker job');
        }
        await this.queueJob({
          runId: run.id,
          stage: effect.stage,
          action: ACTION_BY_STAGE[effect.stage],
          idempotencyKey: transitionJobIdempotencyKey(run.id, effect.stage, run.currentRevision),
          input: {
            brief: run.brief,
            ...(run.notebookLmNotebookId ? { notebookLmNotebookId: run.notebookLmNotebookId } : {}),
            ...mediaJobInputForStage(run.brief, effect.stage),
            dependencies: packageVersion.artifactInventory
              .flatMap((reference) => {
                const artifact = this.artifactsById.get(reference.artifactId);
                return artifact?.action === ACTION_BY_STAGE.research ? [toJobArtifactDependency(artifact)] : [];
              }),
            review: { comment: input.comment!, packageChecksum: input.packageChecksum },
          },
        });
      }
    }
    return { ...run, nextRetryAt: this.nextRetryAt(run) };
  }

  async recordPackageChange(input: RecordPackageChangeInput): Promise<WorkflowRun> {
    const run = this.requireRun(input.runId);
    if (run.packageChecksum === input.packageChecksum) return { ...run, nextRetryAt: this.nextRetryAt(run) };
    const stage = run.stages[run.currentStage];
    if (!stage) throw new WorkflowConflictError('Current stage does not exist');
    const transition = nextTransition({
      stage: run.currentStage,
      state: stage.state,
      revisionAttempts: stage.revisionAttempts,
      packageChecksum: run.packageChecksum as `${string}` | null,
      approvedChecksum: run.approvedChecksum as `${string}` | null,
      reason: stage.reason ?? undefined,
    }, { type: 'package_changed', packageChecksum: input.packageChecksum as `${string}` });
    const nextStage = run.stages[transition.stage] ?? {
      name: transition.stage,
      state: transition.state,
      reason: null,
      attempt: 0,
      revisionAttempts: 0,
    };
    run.stages[transition.stage] = nextStage;
    nextStage.state = transition.state;
    nextStage.reason = transition.reason ?? null;
    nextStage.revisionAttempts = transition.revisionAttempts;
    run.currentStage = transition.stage;
    run.packageChecksum = transition.packageChecksum;
    run.approvedChecksum = transition.approvedChecksum;
    run.reviewStatus = reviewStatusForTransition(run.reviewStatus, transition);
    run.updatedAt = this.clock();
    this.supersedeDeliveryJobs(run.id, input.packageChecksum);
    return { ...run, nextRetryAt: this.nextRetryAt(run) };
  }

  async recordPackageVersion(input: RecordPackageVersionInput): Promise<WorkflowPackageVersion> {
    assertPackageVersionChecksum(input);
    const run = this.requireRun(input.runId);
    if (run.currentRevision !== input.revision) {
      throw new WorkflowConflictError('Package version revision must match the current run revision');
    }
    const identity = packageVersionIdentity(input);
    const existing = this.packageVersionsByIdentity.get(identity);
    const version = existing ? resolveExistingPackageVersion(existing, input) : {
      ...input,
      id: input.id ?? this.idGenerator(),
      createdAt: this.clock(),
    };
    this.packageVersionsByIdentity.set(identity, version);
    if (run.packageChecksum !== input.packageChecksum) {
      await this.recordPackageChange({ runId: input.runId, packageChecksum: input.packageChecksum });
    }
    return version;
  }

  private supersedeDeliveryJobs(runId: string, packageChecksum: string): void {
    for (const job of this.jobs.values()) {
      if (job.runId === runId
        && job.stage === 'deliver'
        && (job.state === 'queued' || job.state === 'running')
        && job.input.packageChecksum !== packageChecksum) {
        job.state = 'superseded';
        job.leaseOwner = null;
        job.leaseExpiresAt = null;
        job.updatedAt = this.clock();
      }
    }
    for (const delivery of this.deliveriesByIdempotencyKey.values()) {
      if (delivery.runId === runId
        && delivery.packageChecksum !== packageChecksum
        && ['queued', 'running', 'waiting', 'failed', 'verifying'].includes(delivery.state)) {
        delivery.state = 'superseded';
        delivery.nextAttemptAt = null;
        delivery.updatedAt = this.clock();
      }
    }
  }

  private requireRun(runId: string): WorkflowRun {
    const run = this.runs.get(runId);
    if (!run) throw new WorkflowNotFoundError('Run not found');
    return run;
  }

  private nextRetryAt(run: WorkflowRun): Date | null {
    if (run.stages[run.currentStage]?.state !== 'waiting') return null;
    return [...this.jobs.values()]
      .filter((job) => job.runId === run.id && job.state === 'queued')
      .sort((left, right) => left.availableAt.getTime() - right.availableAt.getTime())[0]
      ?.availableAt ?? null;
  }
}

function assertLeaseSeconds(leaseSeconds: number): void {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0) {
    throw new TypeError('Lease seconds must be a positive integer');
  }
}

function assertResearchRefreshAllowed(input: {
  currentStage: string;
  reviewStatus: string;
  approvedChecksum: string | null;
  createState: string | undefined;
}): void {
  if (input.currentStage !== 'create' || input.createState !== 'needs_human') {
    throw new WorkflowConflictError('Research refresh requires Create to need human intervention');
  }
  if (input.reviewStatus !== 'pending' || input.approvedChecksum !== null) {
    throw new WorkflowConflictError('Research refresh requires an unapproved pending run');
  }
}

function assertResearchRefreshBrief(brief: JsonObject, notebookLmNotebookId: string | undefined): void {
  const parsed = knowledgeBitsRunBriefSchema.safeParse(brief);
  if (!parsed.success) throw new WorkflowValidationError('Research refresh requires a valid run brief');
  if (!notebookLmNotebookId || notebookIdFromBrief(brief) !== notebookLmNotebookId) {
    throw new WorkflowValidationError('Research refresh cannot change the NotebookLM notebook');
  }
}

function notebookIdFromBrief(brief: JsonObject): string | undefined {
  const value = brief.notebookLmNotebookId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function assertExecutionSeconds(executionSeconds: number | undefined): void {
  if (executionSeconds !== undefined
    && (!Number.isInteger(executionSeconds) || executionSeconds <= 0 || executionSeconds > 3_600)) {
    throw new TypeError('Execution seconds must be a positive integer no greater than 3600');
  }
}

interface JobArtifactDependency {
  artifactId: string;
  revision: number;
  kind: string;
  mediaType: string;
  checksum: string;
  action: string;
  sourceId?: string;
}

function nextJobDependencies(
  input: JsonObject,
  completedArtifacts: readonly WorkflowArtifact[],
  nextStage: Exclude<WorkflowStage, 'human_review' | 'deliver'>,
): JobArtifactDependency[] {
  const dependencies = [
    ...dependenciesFromJobInput(input),
    ...completedArtifacts.map(toJobArtifactDependency),
  ];
  const filtered = nextStage === 'create'
    ? dependencies.filter((dependency) => dependency.action === ACTION_BY_STAGE.research)
    : dependencies;
  return [...new Map(filtered.map((dependency) => [dependency.artifactId, dependency])).values()];
}

function mediaJobInputForStage(
  brief: JsonObject,
  stage: Exclude<WorkflowStage, 'human_review' | 'deliver'>,
): JsonObject {
  if (stage !== 'produce_assets') return {};
  const generationPlan = nugletGenerationPlanSchema.safeParse(brief.generationPlan);
  if (!generationPlan.success) return {};
  if (generationPlan.data.mediaMode === 'reuse_legacy') {
    return {
      mediaOperation: 'attach_existing',
      mediaKinds: ['hero', 'infographic', 'audio_brief', 'audio_discussion'],
    };
  }
  if (generationPlan.data.heroMode !== 'deferred') return {};
  return {
    mediaOperation: 'generate',
    mediaKinds: ['infographic', 'audio_brief', 'audio_discussion'],
  };
}

function dependenciesFromJobInput(input: JsonObject): JobArtifactDependency[] {
  if (!Array.isArray(input.dependencies)) return [];
  return input.dependencies.filter(isJobArtifactDependency);
}

function isJobArtifactDependency(value: unknown): value is JobArtifactDependency {
  return isRecord(value)
    && typeof value.artifactId === 'string'
    && Number.isInteger(value.revision)
    && typeof value.kind === 'string'
    && typeof value.mediaType === 'string'
    && typeof value.checksum === 'string'
    && typeof value.action === 'string'
    && (value.sourceId === undefined || typeof value.sourceId === 'string');
}

function toJobArtifactDependency(artifact: WorkflowArtifact): JobArtifactDependency {
  if (!artifact.action) throw new WorkflowConflictError('Artifact dependency is missing its producing action');
  const sourceId = typeof artifact.provenance.sourceId === 'string' ? artifact.provenance.sourceId : undefined;
  return {
    artifactId: artifact.id,
    revision: artifact.revision,
    kind: artifact.kind,
    mediaType: artifact.mediaType,
    checksum: artifact.checksum,
    action: artifact.action,
    ...(sourceId ? { sourceId } : {}),
  };
}

function packageArtifactIds(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((reference) => (
    isRecord(reference) && typeof reference.artifactId === 'string' ? [reference.artifactId] : []
  ));
}

function isLegacyMediaReconciliationInput(input: JsonObject): boolean {
  return input.mediaOperation === 'attach_existing'
    && Array.isArray(input.mediaKinds)
    && input.mediaKinds.some((kind) => kind === 'audio_brief' || kind === 'audio_discussion');
}

function currentReconciliationDependencies(
  artifacts: Iterable<WorkflowArtifact>,
  runId: string,
  revision: number,
): JobArtifactDependency[] {
  return [...artifacts]
    .filter((artifact) => artifact.runId === runId
      && artifact.revision === revision
      && artifact.kind === 'parsed_output'
      && (artifact.action === ACTION_BY_STAGE.create || artifact.action === ACTION_BY_STAGE.check))
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
    .map(toJobArtifactDependency);
}

function assertLegacyAudioReuse(brief: JsonObject): void {
  const generationPlan = isRecord(brief.generationPlan) ? brief.generationPlan : {};
  const reuse = isRecord(generationPlan.legacyMediaReuse)
    ? generationPlan.legacyMediaReuse
    : isRecord(brief.legacyMediaReuse) ? brief.legacyMediaReuse : undefined;
  const artifacts = reuse && isRecord(reuse.artifacts) ? reuse.artifacts : undefined;
  if (reuse?.source !== 'nuglet_published'
    || typeof reuse.sourceRunId !== 'string'
    || !isRecord(artifacts?.audioBrief)
    || !isRecord(artifacts?.audioDiscussion)) {
    throw new WorkflowValidationError('The run does not contain both existing legacy audio receipts');
  }
}

function legacyAudioReconciliationJobIdempotencyKey(runId: string, revision: number): string {
  return `workflow:${runId}:produce_assets:legacy-audio:${revision}`;
}

function assertRegenerableMediaKinds(kinds: readonly RegenerableMediaKind[]): void {
  const allowed = new Set<RegenerableMediaKind>(['hero', 'infographic', 'audio_brief', 'audio_discussion', 'public_preview']);
  if (!kinds.length || new Set(kinds).size !== kinds.length || kinds.some((kind) => !allowed.has(kind))) {
    throw new WorkflowValidationError('Media regeneration requires distinct supported media kinds');
  }
}

function briefWithMediaRecipeOverrides(
  brief: JsonObject,
  recipeOverrides?: MediaRecipeOverrides,
): JsonObject {
  if (!recipeOverrides?.infographic && !recipeOverrides?.heroMode) return brief;
  const parsedPlan = nugletGenerationPlanSchema.safeParse(brief.generationPlan);
  if (!parsedPlan.success) {
    throw new WorkflowValidationError('Media recipe override requires a valid Nuglet generation plan');
  }
  const nextPlan = nugletGenerationPlanSchema.safeParse({
    ...parsedPlan.data,
    recipes: {
      ...parsedPlan.data.recipes,
      ...(recipeOverrides.infographic ? { infographic: recipeOverrides.infographic } : {}),
    },
    ...(recipeOverrides.heroMode ? { heroMode: recipeOverrides.heroMode } : {}),
  });
  if (!nextPlan.success) {
    throw new WorkflowValidationError('The requested media recipe override is incompatible with this run');
  }
  return {
    ...brief,
    generationPlan: nextPlan.data,
  };
}

function briefWithMediaRegenerationSource(
  brief: JsonObject,
  sourcePackageChecksum: string | undefined,
  regeneratedKinds: readonly RegenerableMediaKind[],
): JsonObject {
  if (!sourcePackageChecksum) return brief;
  return {
    ...brief,
    mediaRegeneration: {
      sourcePackageChecksum,
      regeneratedKinds: [...regeneratedKinds],
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArtifactKindAuthorizedForJob(kind: string, job: WorkflowJob): boolean {
  if (job.stage === 'produce_assets' && job.action === 'produce_assets') return true;
  if (job.stage === 'research' && job.action === 'collect_sources' && kind === 'source_snapshot') return true;
  return AUDIT_ARTIFACT_KINDS.has(kind)
    && job.stage !== 'human_review'
    && job.action === ACTION_BY_STAGE[job.stage];
}

function assertWorkerId(workerId: string): void {
  if (!workerId.trim()) throw new TypeError('Worker id must not be blank');
}

function assertCapabilities(capabilities: string[] | undefined): void {
  if (capabilities && (!capabilities.length || capabilities.some((capability) => !capability.trim()))) {
    throw new TypeError('Worker capabilities must contain nonblank actions');
  }
}

function assertStrictLegacyReplacement(input: PrepareLegacyRevisionInput): void {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision <= 0) {
    throw new WorkflowValidationError('Expected revision must be a positive integer');
  }
  if (!/^[a-f0-9]{64}$/.test(input.expectedPackageChecksum)) {
    throw new WorkflowValidationError('Expected package checksum must be a 64-character checksum');
  }
  if (!input.notebookLmNotebookId.trim() || !input.comment.trim() || !input.operatorId.trim()) {
    throw new WorkflowValidationError('Notebook ID, operator identity, and comment are required');
  }
  const brief = knowledgeBitsRunBriefSchema.safeParse(input.brief);
  const plan = brief.success ? nugletGenerationPlanSchema.safeParse(brief.data.generationPlan) : undefined;
  if (!brief.success || !plan?.success || plan.data.contentKind !== 'nuglet.lesson.v1') {
    throw new WorkflowValidationError('Legacy revision preparation requires a strict Nuglet replacement brief');
  }
  const evidenceNotebookId = plan.data.mediaBaseline?.descriptor.notebookId
    ?? plan.data.legacyMediaReuse?.notebookId;
  if (brief.data.notebookLmNotebookId !== input.notebookLmNotebookId
    || evidenceNotebookId !== input.notebookLmNotebookId) {
    throw new WorkflowValidationError('Replacement brief notebook binding must match the requested notebook');
  }
}

function assertLegacyRevisionFence(
  run: {
    currentRevision: number;
    packageChecksum: string | null;
    approvedChecksum: string | null;
    currentStage: string;
    reviewStatus: string;
    notebookLmNotebookId?: string | null;
    brief: unknown;
  },
  input: PrepareLegacyRevisionInput,
): void {
  if (run.currentRevision !== input.expectedRevision) {
    throw new WorkflowConflictError('Legacy revision expected revision does not match the current run revision');
  }
  if (run.packageChecksum !== input.expectedPackageChecksum) {
    throw new WorkflowConflictError('Legacy revision expected package checksum does not match the current package');
  }
  if (run.currentStage !== 'human_review'
    || !['pending', 'changes_requested'].includes(run.reviewStatus)
    || run.approvedChecksum !== null) {
    throw new WorkflowConflictError('Legacy revision preparation requires an unapproved human review run');
  }
  if (isStrictNugletBrief(run.brief)) {
    throw new WorkflowConflictError('Legacy revision preparation rejects an already strict run');
  }
  if (!run.notebookLmNotebookId || run.notebookLmNotebookId !== input.notebookLmNotebookId) {
    throw new WorkflowConflictError('Legacy revision preparation cannot change the NotebookLM notebook');
  }
}

function isStrictNugletBrief(value: unknown): boolean {
  const brief = knowledgeBitsRunBriefSchema.safeParse(value);
  return brief.success && nugletGenerationPlanSchema.safeParse(brief.data.generationPlan).success;
}

function legacyRevisionOperation(input: PrepareLegacyRevisionInput): {
  effectKey: string;
  replacementBriefChecksum: string;
  payload: JsonObject;
} {
  const replacementBriefChecksum = legacyBriefChecksum(input.brief);
  return {
    effectKey: `legacy-revision:${input.runId}:${input.expectedRevision}:${input.expectedPackageChecksum}:${replacementBriefChecksum}`,
    replacementBriefChecksum,
    payload: {
      operatorId: input.operatorId,
      comment: input.comment,
      previousRevision: input.expectedRevision,
      newRevision: input.expectedRevision + 1,
      previousPackageChecksum: input.expectedPackageChecksum,
      replacementBriefChecksum,
    },
  };
}

function assertLegacyRevisionReplay(actual: unknown, expected: JsonObject): void {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new WorkflowConflictError('Legacy revision preparation conflicts with an existing operation');
  }
}

function legacyBriefChecksum(brief: JsonObject): string {
  return createHash('sha256').update(canonicalJson(brief)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isJsonObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new WorkflowValidationError('Legacy revision brief must contain JSON values');
}

function assertRetryAtInFuture(retryAt: Date | undefined, now: Date): void {
  if (retryAt && retryAt <= now) {
    throw new WorkflowValidationError('retryAt must be in the future');
  }
}

function assertDurableEffect(condition: boolean, message: string): void {
  if (!condition) throw new WorkflowConflictError(message);
}

function reviewIdentity(input: RecordReviewInput): string {
  return `${input.runId}:${input.packageChecksum}`;
}

function reviewIdentityWhere(input: RecordReviewInput) {
  return {
    runId: input.runId,
    packageChecksum: input.packageChecksum,
  };
}

function toRecordReviewInput(run: Pick<WorkflowRun, 'id' | 'currentRevision'>, input: ReviewRunInput): RecordReviewInput {
  if ((input.decision === 'request_changes' || input.decision === 'reject') && !input.comment?.trim()) {
    throw new WorkflowValidationError('Changes and rejections require a comment');
  }
  if (input.decision === 'approve' && input.comment !== undefined) {
    throw new WorkflowValidationError('Approval does not accept a comment');
  }
  return {
    runId: run.id,
    revision: run.currentRevision,
    packageChecksum: input.packageChecksum,
    decision: input.decision,
    reviewerId: input.reviewerId,
    comment: input.comment?.trim() ?? null,
  };
}

function reviewEvent(input: ReviewRunInput) {
  if (input.decision === 'approve') {
    return { type: 'review_approved' as const, packageChecksum: input.packageChecksum as `${string}`, reviewerId: input.reviewerId };
  }
  if (input.decision === 'reject') {
    return { type: 'review_rejected' as const, reason: input.comment!.trim(), reviewerId: input.reviewerId };
  }
  return { type: 'changes_requested' as const, reason: input.comment!.trim(), reviewerId: input.reviewerId };
}

function reviewStatusForDecision(decision: ReviewRunInput['decision']): ReviewStatus {
  if (decision === 'approve') return 'approved';
  if (decision === 'reject') return 'rejected';
  return 'changes_requested';
}

function reviewStatusForTransition(current: ReviewStatus, transition: TransitionResult): ReviewStatus {
  if (transition.stage === 'human_review' && transition.state === 'needs_human') return 'pending';
  if (transition.approvedChecksum !== null) return 'approved';
  return current;
}

function initialJobIdempotencyKey(runId: string): string {
  return `workflow:${runId}:research:1`;
}

function transitionJobIdempotencyKey(
  runId: string,
  stage: Exclude<WorkflowStage, 'human_review'>,
  revision: number,
): string {
  return `workflow:${runId}:${stage}:${revision}`;
}

function deliveryJobIdempotencyKey(runId: string, revision: number, packageChecksum: string): string {
  return `workflow:${runId}:deliver:${revision}:${packageChecksum}`;
}

function externalDeliveryIdempotencyKey(packageVersionId: string, packageChecksum: string): string {
  return createHash('sha256')
    .update(`knowledge-bits:delivery:${packageVersionId}:${packageChecksum}`)
    .digest('hex');
}

function deliveryRetryJobIdempotencyKey(deliveryId: string, attempt: number): string {
  return `workflow:delivery:${deliveryId}:attempt:${attempt}`;
}

function deliveryJobInput(delivery: WorkflowDelivery, brief: JsonObject): JsonObject {
  return {
    brief,
    deliveryId: delivery.id,
    packageChecksum: delivery.packageChecksum,
    packageVersionId: delivery.packageVersionId,
  };
}

function deliveryClaimIdentity(input: JsonObject): {
  deliveryId: string;
  packageVersionId: string;
  packageChecksum: string;
} {
  if (typeof input.deliveryId !== 'string'
    || typeof input.packageVersionId !== 'string'
    || typeof input.packageChecksum !== 'string') {
    throw new WorkflowConflictError('Delivery job is missing immutable package identity');
  }
  return {
    deliveryId: input.deliveryId,
    packageVersionId: input.packageVersionId,
    packageChecksum: input.packageChecksum,
  };
}

function packageTargetKind(content: Prisma.JsonValue): string {
  if (isJsonObject(content) && isJsonObject(content.target) && typeof content.target.kind === 'string') {
    return content.target.kind;
  }
  throw new WorkflowConflictError('Immutable package target is missing');
}

function retryJobIdempotencyKey(jobId: string, attempt: number): string {
  return `workflow:${jobId}:retry:${attempt}`;
}

function workflowEffectKey(jobId: string, index: number): string {
  return `job:${jobId}:effect:${index}`;
}

async function queueTransitionJob(
  transaction: Prisma.TransactionClient,
  input: {
    runId: string;
    stage: Exclude<WorkflowStage, 'human_review'>;
    revision: number;
    input: JsonObject;
  },
): Promise<void> {
  await transaction.job.upsert({
    where: {
      idempotencyKey: input.stage === 'deliver' && typeof input.input.packageChecksum === 'string'
        ? deliveryJobIdempotencyKey(input.runId, input.revision, input.input.packageChecksum)
        : transitionJobIdempotencyKey(input.runId, input.stage, input.revision),
    },
    update: {},
    create: {
      runId: input.runId,
      stage: input.stage,
      action: ACTION_BY_STAGE[input.stage],
      state: 'queued',
      idempotencyKey: input.stage === 'deliver' && typeof input.input.packageChecksum === 'string'
        ? deliveryJobIdempotencyKey(input.runId, input.revision, input.input.packageChecksum)
        : transitionJobIdempotencyKey(input.runId, input.stage, input.revision),
      input: toPrismaJson(input.input),
    },
  });
}

function toStageMap(
  stages: Array<{
    name: WorkflowStage | string;
    state: StageState | string;
    reason?: string | null;
    attempt?: number;
    revisionAttempt?: number;
    revisionAttempts?: number;
  }>,
): Partial<Record<WorkflowStage, WorkflowStageSnapshot>> {
  return Object.fromEntries(stages.map((stage) => [stage.name, {
    name: stage.name as WorkflowStage,
    state: stage.state as StageState,
    reason: stage.reason ?? null,
    attempt: stage.attempt ?? 0,
    revisionAttempts: stage.revisionAttempts ?? stage.revisionAttempt ?? 0,
  }])) as Partial<Record<WorkflowStage, WorkflowStageSnapshot>>;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toPrismaJson(value: JsonObject): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function mergeDeliveryResponse(
  current: Prisma.JsonValue | JsonObject | null,
  incoming: JsonObject | null,
): JsonObject {
  return {
    ...(isJsonObject(current) ? current : {}),
    ...(incoming ?? {}),
  };
}

function mergeLateDeliveryEvidence(
  current: Prisma.JsonValue | JsonObject | null,
  incoming: JsonObject | null,
): JsonObject {
  const existing = isJsonObject(current) ? current : {};
  const evidence = incoming ?? {};
  const existingLateEvidence = Array.isArray(existing.lateEvidence) ? existing.lateEvidence : [];
  return {
    ...evidence,
    ...existing,
    lateEvidence: [...existingLateEvidence, evidence],
  };
}

function toWorkflowRun(run: {
  id: string;
  title: string;
  locale: string;
  brief: Prisma.JsonValue;
  notebookLmNotebookId: string | null;
  currentStage: string;
  currentRevision: number;
  packageChecksum: string | null;
  approvedChecksum: string | null;
  reviewStatus: string;
  stages?: Array<{
    name: string;
    state: string;
    reason: string | null;
    attempt: number;
    revisionAttempt: number;
  }>;
  jobs?: Array<{ availableAt: Date }>;
  createdAt: Date;
  updatedAt: Date;
}): WorkflowRun {
  const { stages: stageRows, jobs, notebookLmNotebookId, ...base } = run;
  const stages = stageRows ? toStageMap(stageRows) : {};
  return {
    ...base,
    ...(notebookLmNotebookId ? { notebookLmNotebookId } : {}),
    brief: base.brief as JsonObject,
    currentStage: base.currentStage as WorkflowStage,
    reviewStatus: base.reviewStatus as ReviewStatus,
    stages,
    nextRetryAt: stages[base.currentStage as WorkflowStage]?.state === 'waiting'
      ? jobs?.[0]?.availableAt ?? null
      : null,
  };
}

function toWorkflowJob(job: {
  id: string;
  runId: string;
  stage: string;
  action: string;
  state: string;
  idempotencyKey: string;
  availableAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  executionDeadlineAt: Date | null;
  attempt: number;
  input: Prisma.JsonValue;
  result: Prisma.JsonValue | null;
  completionReceipt: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
}): WorkflowJob {
  return {
    ...job,
    stage: job.stage as WorkflowStage,
    state: job.state as StageState | 'superseded',
    input: job.input as JsonObject,
    result: job.result as JobResult | null,
    completionReceipt: parseCompletionReceipt(job.completionReceipt),
  };
}

interface CompletionReceiptInput {
  workerId: string;
  result: JobResult;
  retryAt: string | null;
}

interface CompletionReceipt {
  input: CompletionReceiptInput;
  run: SerializedWorkflowRun;
}

interface SerializedWorkflowRun extends Omit<WorkflowRun, 'createdAt' | 'updatedAt' | 'nextRetryAt'> {
  createdAt: string;
  updatedAt: string;
  nextRetryAt: string | null;
}

function completionReceiptInput(input: ApplyJobResultInput): CompletionReceiptInput {
  return {
    workerId: input.workerId,
    result: input.result,
    retryAt: input.retryAt?.toISOString() ?? null,
  };
}

function createCompletionReceipt(input: CompletionReceiptInput, run: WorkflowRun): CompletionReceipt {
  return {
    input,
    run: {
      ...run,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      nextRetryAt: run.nextRetryAt?.toISOString() ?? null,
    },
  };
}

function replayCompletionReceipt(value: unknown, expected: CompletionReceiptInput): WorkflowRun {
  const receipt = parseCompletionReceipt(value);
  if (!receipt || !isDeepStrictEqual(receipt.input, expected)) {
    throw new WorkflowConflictError('Job result conflicts with the completed result');
  }
  return {
    ...receipt.run,
    createdAt: new Date(receipt.run.createdAt),
    updatedAt: new Date(receipt.run.updatedAt),
    nextRetryAt: receipt.run.nextRetryAt ? new Date(receipt.run.nextRetryAt) : null,
  };
}

function parseCompletionReceipt(value: unknown): CompletionReceipt | null {
  if (!isJsonObject(value) || !isJsonObject(value.input) || !isJsonObject(value.run)) return null;
  const { input, run } = value;
  if (typeof input.workerId !== 'string'
    || !isJsonObject(input.result)
    || (typeof input.retryAt !== 'string' && input.retryAt !== null)
    || typeof run.createdAt !== 'string'
    || typeof run.updatedAt !== 'string'
    || (typeof run.nextRetryAt !== 'string' && run.nextRetryAt !== null)) {
    return null;
  }
  return value as unknown as CompletionReceipt;
}

function toWorkflowArtifact(artifact: {
  id: string;
  runId: string;
  revision: number;
  kind: string;
  mediaType: string;
  checksum: string;
  storageKey: string;
  byteSize: number;
  provenance: Prisma.JsonValue;
  inputChecksum: string | null;
  jobId: string | null;
  stage: string | null;
  action: string | null;
  createdAt: Date;
}): WorkflowArtifact {
  return {
    ...artifact,
    stage: artifact.stage as WorkflowStage | null,
    provenance: artifact.provenance as JsonObject,
  };
}

function toWorkflowDelivery(delivery: {
  id: string;
  runId: string;
  packageVersionId: string;
  target: string;
  packageChecksum: string;
  idempotencyKey: string;
  state: string;
  attempts: number;
  response: Prisma.JsonValue | null;
  nextAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): WorkflowDelivery {
  return { ...delivery, response: delivery.response as JsonObject | null };
}

function throwUniqueConflict(error: unknown, message: string): never {
  if (isPrismaUniqueConflict(error)) {
    throw new WorkflowConflictError(message);
  }

  throw error;
}

function throwArtifactUniqueConflict(error: unknown): never {
  if (isPrismaUniqueConflict(error)) {
    const detail = uniqueConflictDetail(error);
    if (detail.includes('Artifact_pkey') || /\bid\b/i.test(detail)) {
      throw new WorkflowConflictError('Artifact ID already exists');
    }
    throw new WorkflowConflictError('Artifact storage key already exists');
  }

  throw error;
}

function isPrismaUniqueConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  if (error.code === 'P2002') return true;
  return error.code === 'P2010'
    && 'meta' in error
    && typeof error.meta === 'object'
    && error.meta !== null
    && 'code' in error.meta
    && error.meta.code === '23505';
}

function uniqueConflictDetail(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
  const meta = 'meta' in error && typeof error.meta === 'object' && error.meta !== null ? error.meta : {};
  const target = 'target' in meta ? meta.target : '';
  const detail = 'message' in meta && typeof meta.message === 'string' ? meta.message : '';
  return `${message} ${detail} ${Array.isArray(target) ? target.join(' ') : String(target)}`;
}

function resolveExistingReview(
  review: WorkflowReview,
  input: RecordReviewInput,
): WorkflowReview {
  if (review.decision !== input.decision
    || review.reviewerId !== input.reviewerId
    || review.comment !== input.comment) {
    throw new WorkflowConflictError('Review decision conflicts with the existing review');
  }

  return review;
}

function packageVersionIdentity(input: Pick<RecordPackageVersionInput, 'runId' | 'revision' | 'packageChecksum'>): string {
  return `${input.runId}:${input.revision}:${input.packageChecksum}`;
}

function assertPackageVersionChecksum(input: RecordPackageVersionInput): void {
  const calculated = calculatePackageChecksum({
    content: input.content,
    evidence: input.evidence,
    qa: input.qa,
    assetInventory: input.artifactInventory,
    adapterVersion: input.adapterVersion,
    locale: input.locale,
    owner: input.owner,
    usageRights: input.usageRights as JsonValue,
  });
  if (calculated !== input.packageChecksum) {
    throw new WorkflowConflictError('Package checksum does not match the canonical package contents');
  }
}

function resolveExistingPackageVersion(
  version: WorkflowPackageVersion,
  input: RecordPackageVersionInput,
): WorkflowPackageVersion {
  const comparable = {
    runId: version.runId,
    revision: version.revision,
    packageChecksum: version.packageChecksum,
    adapterVersion: version.adapterVersion,
    locale: version.locale,
    owner: version.owner,
    usageRights: version.usageRights,
    content: version.content,
    evidence: version.evidence,
    qa: version.qa,
    artifactInventory: version.artifactInventory,
  };
  const expected = { ...input };
  delete expected.id;
  if (!isDeepStrictEqual(comparable, expected)) {
    throw new WorkflowConflictError('Package version conflicts with the existing immutable package');
  }
  return version;
}

function latestReviewMediaArtifacts(artifacts: readonly WorkflowArtifact[]): WorkflowArtifact[] {
  const latestByKind = new Map<string, WorkflowArtifact>();
  for (const artifact of artifacts) {
    if (REVIEW_MEDIA_ARTIFACT_KINDS.has(artifact.kind)) latestByKind.set(artifact.kind, artifact);
  }
  return artifacts.filter((artifact) => (
    !REVIEW_MEDIA_ARTIFACT_KINDS.has(artifact.kind) || latestByKind.get(artifact.kind)?.id === artifact.id
  ));
}

async function lockRun(transaction: Prisma.TransactionClient, runId: string): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`SELECT "id" FROM "Run" WHERE "id" = ${runId} FOR UPDATE`);
}

async function supersedeDeliveryJobs(
  transaction: Prisma.TransactionClient,
  runId: string,
  packageChecksum: string,
): Promise<void> {
  await transaction.$executeRaw(Prisma.sql`
    UPDATE "Job"
    SET "state" = 'superseded',
        "leaseOwner" = NULL,
        "leaseExpiresAt" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "runId" = ${runId}
      AND "stage" = 'deliver'
      AND "state" IN ('queued', 'running')
      AND COALESCE("input"->>'packageChecksum', '') <> ${packageChecksum}
  `);
  await transaction.delivery.updateMany({
    where: {
      runId,
      packageChecksum: { not: packageChecksum },
      state: { in: ['queued', 'running', 'waiting', 'failed', 'verifying'] },
    },
    data: { state: 'superseded', nextAttemptAt: null },
  });
}

function toWorkflowPackageVersion(version: {
  id: string;
  runId: string;
  revision: number;
  packageChecksum: string;
  adapterVersion: string;
  locale: string;
  owner: string;
  usageRights: Prisma.JsonValue;
  content: Prisma.JsonValue;
  evidence: Prisma.JsonValue;
  qa: Prisma.JsonValue;
  artifactInventory: Prisma.JsonValue;
  createdAt: Date;
}): WorkflowPackageVersion {
  return {
    ...version,
    usageRights: version.usageRights as JsonObject,
    content: version.content as unknown as KnowledgeBitsContent,
    evidence: version.evidence as unknown as KnowledgeBitsEvidence,
    qa: version.qa as unknown as KnowledgeBitsQa,
    artifactInventory: version.artifactInventory as unknown as ArtifactReference[],
  };
}
