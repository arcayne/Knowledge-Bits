import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type {
  JobClaim,
  JobResult,
  StageState,
  WorkflowStage,
} from '@knowledge-bits/contracts';
import type { TransitionResult } from '@knowledge-bits/pipeline';
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
const AUDIT_ARTIFACT_KINDS = new Set(['raw_response', 'parsed_output', 'execution_report']);

export interface WorkflowRun {
  id: string;
  title: string;
  locale: string;
  brief: JsonObject;
  currentStage: WorkflowStage;
  currentRevision: number;
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
  state: StageState;
  idempotencyKey: string;
  availableAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
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

export interface CreateRunInput {
  id?: string;
  title: string;
  locale: string;
  brief: JsonObject;
  currentStage?: WorkflowStage;
  currentRevision?: number;
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
  now?: Date;
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

export interface RecordDeliveryInput {
  id?: string;
  runId: string;
  target: string;
  packageChecksum: string;
  idempotencyKey: string;
  state: string;
  response?: JsonObject | null;
  nextAttemptAt?: Date | null;
}

export interface WorkflowStore {
  createRun(input: CreateRunInput): Promise<WorkflowRun>;
  bootstrapRun(input: BootstrapRunInput): Promise<WorkflowRun>;
  getRun(id: string): Promise<WorkflowRun | null>;
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
}

export class WorkflowConflictError extends Error {}
export class WorkflowValidationError extends Error {}

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
  revision: number;
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
        currentStage,
        currentRevision: input.currentRevision ?? 1,
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
      const run = await transaction.run.create({
        data: {
          id: input.id,
          title: input.title,
          locale: input.locale,
          brief: toPrismaJson(input.brief),
          currentStage: 'research',
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
          input: toPrismaJson({ brief: input.brief }),
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
      packageChecksum: latestPackageChecksum(job.run.jobs),
      approvedChecksum: null,
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

  async claimJob(input: ClaimJobInput): Promise<JobClaim | null> {
    assertWorkerId(input.workerId);
    assertLeaseSeconds(input.leaseSeconds);
    assertCapabilities(input.capabilities);
    const claimedAt = input.now ?? new Date();
    const leaseExpiresAt = new Date(claimedAt.getTime() + input.leaseSeconds * 1_000);
    const capabilityFilter = input.capabilities?.length
      ? Prisma.sql`AND "action" IN (${Prisma.join(input.capabilities)})`
      : Prisma.empty;
    return this.prisma.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<ClaimedJobRow[]>(Prisma.sql`
      UPDATE "Job"
      SET "state" = 'running',
          "leaseOwner" = ${input.workerId},
          "leaseExpiresAt" = ${leaseExpiresAt},
          "attempt" = "attempt" + 1,
          "updatedAt" = ${claimedAt}
      WHERE "id" = (
        SELECT "Job"."id"
        FROM "Job"
        INNER JOIN "Run" ON "Run"."id" = "Job"."runId"
        WHERE "Job"."state" = 'queued'
          AND "Job"."availableAt" <= ${claimedAt}
          AND "Run"."currentStage" = "Job"."stage"
          ${capabilityFilter}
        ORDER BY "Job"."availableAt" ASC, "Job"."createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      ) AND "state" = 'queued'
      RETURNING "id", "runId", "stage", "attempt", "leaseExpiresAt",
        (SELECT "currentRevision" FROM "Run" WHERE "Run"."id" = "Job"."runId") AS "revision"
      `);
      const row = rows[0];

      if (!row) return null;
      await transaction.stage.update({
        where: { runId_name: { runId: row.runId, name: row.stage } },
        data: { state: 'running', reason: null, attempt: row.attempt },
      });

      return {
        jobId: row.id,
        packageId: row.runId,
        stage: row.stage as WorkflowStage,
        claimedBy: input.workerId,
        claimedAt: claimedAt.toISOString(),
        leaseExpiresAt: row.leaseExpiresAt.toISOString(),
        attempt: row.attempt,
        revision: row.revision,
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
        stage: 'produce_assets',
        action: 'produce_assets',
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
      const completed = await transaction.$executeRaw(Prisma.sql`
        UPDATE "Job"
        SET "state" = ${input.result.state},
            "result" = CAST(${JSON.stringify(input.result)} AS jsonb),
            "leaseOwner" = NULL,
            "leaseExpiresAt" = NULL,
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
        data: { currentStage: transition.stage, currentRevision: nextRevision },
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
            input: job.run.brief as JsonObject,
          });
        }
        if (effect.type === 'queue_delivery') {
          await queueTransitionJob(transaction, {
            runId: job.runId,
            stage: 'deliver',
            revision: nextRevision,
            input: job.run.brief as JsonObject,
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
            transition.stage === 'check' && transition.state === 'needs_human',
            'Human request was not represented by the check stage',
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
          "id", "runId", "revision", "kind", "mediaType", "checksum", "storageKey", "byteSize", "provenance", "inputChecksum"
        )
        SELECT
          ${artifactId}, ${input.runId}, ${input.revision}, ${input.kind}, ${input.mediaType}, ${input.checksum},
          ${input.storageKey}, ${input.byteSize}, CAST(${JSON.stringify(input.provenance)} AS jsonb), ${input.inputChecksum}
        FROM "Job"
        INNER JOIN "Run" ON "Run"."id" = "Job"."runId"
        WHERE "Job"."id" = ${input.jobId}
          AND "Job"."runId" = ${input.runId}
          AND (
            ("Job"."stage" = 'produce_assets' AND "Job"."action" = 'produce_assets')
            OR (
              ${input.kind} IN ('raw_response', 'parsed_output', 'execution_report')
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
          "id", "runId", "revision", "kind", "mediaType", "checksum", "storageKey", "byteSize", "provenance", "inputChecksum", "createdAt"
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
      runId_revision_packageChecksum: {
        runId: input.runId,
        revision: input.revision,
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
  private readonly jobs = new Map<string, WorkflowJob>();
  private readonly jobsByIdempotencyKey = new Map<string, string>();
  private readonly artifactsById = new Map<string, WorkflowArtifact>();
  private readonly artifactsByStorageKey = new Map<string, WorkflowArtifact>();
  private readonly reviewsByIdentity = new Map<string, WorkflowReview>();
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
      currentStage: input.currentStage ?? 'research',
      currentRevision: input.currentRevision ?? 1,
      stages: toStageMap(stages),
      nextRetryAt: null,
      createdAt: now,
      updatedAt: now,
    };
    if (this.runs.has(run.id)) throw new WorkflowConflictError('Run already exists');
    this.runs.set(run.id, run);
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
      currentStage: 'research',
      currentRevision: 1,
      stages: toStageMap(BOOTSTRAP_STAGES.map((name) => ({ name, state: 'queued' }))),
      nextRetryAt: null,
      createdAt: now,
      updatedAt: now,
    };
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
      attempt: 0,
      input: { brief: input.brief },
      result: null,
      completionReceipt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(run.id, run);
    this.jobs.set(job.id, job);
    this.jobsByIdempotencyKey.set(job.idempotencyKey, job.id);
    return run;
  }

  async getRun(id: string): Promise<WorkflowRun | null> {
    const run = this.runs.get(id);
    if (!run) return null;
    return { ...run, nextRetryAt: this.nextRetryAt(run) };
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
      packageChecksum: latestPackageChecksum([...this.jobs.values()].filter((candidate) => candidate.runId === run.id)),
      approvedChecksum: null,
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

  async claimJob(input: ClaimJobInput): Promise<JobClaim | null> {
    assertWorkerId(input.workerId);
    assertLeaseSeconds(input.leaseSeconds);
    assertCapabilities(input.capabilities);
    const claimedAt = input.now ?? this.clock();
    const job = [...this.jobs.values()]
      .filter((candidate) => candidate.state === 'queued'
        && candidate.availableAt <= claimedAt
        && this.requireRun(candidate.runId).currentStage === candidate.stage
        && (!input.capabilities?.length || input.capabilities.includes(candidate.action)))
      .sort((left, right) => left.availableAt.getTime() - right.availableAt.getTime()
        || left.createdAt.getTime() - right.createdAt.getTime())[0];

    if (!job) return null;

    job.state = 'running';
    job.leaseOwner = input.workerId;
    job.leaseExpiresAt = new Date(claimedAt.getTime() + input.leaseSeconds * 1_000);
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
      attempt: job.attempt,
      revision: run.currentRevision,
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
    job.updatedAt = completedAt;
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
          input: { brief: run.brief },
        });
      }
      if (effect.type === 'queue_delivery') {
        await this.queueJob({
          runId: run.id,
          stage: 'deliver',
          action: ACTION_BY_STAGE.deliver,
          idempotencyKey: transitionJobIdempotencyKey(run.id, 'deliver', nextRevision),
          input: { brief: run.brief },
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
          transition.stage === 'check' && transition.state === 'needs_human',
          'Human request was not represented by the check stage',
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
    const { jobId: _jobId, workerId: _workerId, ...artifact } = input;
    return this.recordArtifact(artifact);
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

  private requireRun(runId: string): WorkflowRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run does not exist: ${runId}`);
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

function isArtifactKindAuthorizedForJob(kind: string, job: WorkflowJob): boolean {
  if (job.stage === 'produce_assets' && job.action === 'produce_assets') return true;
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

function assertRetryAtInFuture(retryAt: Date | undefined, now: Date): void {
  if (retryAt && retryAt <= now) {
    throw new WorkflowValidationError('retryAt must be in the future');
  }
}

function assertDurableEffect(condition: boolean, message: string): void {
  if (!condition) throw new WorkflowConflictError(message);
}

function reviewIdentity(input: RecordReviewInput): string {
  return `${input.runId}:${input.revision}:${input.packageChecksum}`;
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
    where: { idempotencyKey: transitionJobIdempotencyKey(input.runId, input.stage, input.revision) },
    update: {},
    create: {
      runId: input.runId,
      stage: input.stage,
      action: ACTION_BY_STAGE[input.stage],
      state: 'queued',
      idempotencyKey: transitionJobIdempotencyKey(input.runId, input.stage, input.revision),
      input: toPrismaJson({ brief: input.input }),
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

function latestPackageChecksum(jobs: Array<{ result: unknown }>): string | null {
  for (const job of jobs) {
    if (isJsonObject(job.result) && typeof job.result.outputChecksum === 'string') {
      return job.result.outputChecksum;
    }
  }
  return null;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toPrismaJson(value: JsonObject): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function toWorkflowRun(run: {
  id: string;
  title: string;
  locale: string;
  brief: Prisma.JsonValue;
  currentStage: string;
  currentRevision: number;
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
  const { stages: stageRows, jobs, ...base } = run;
  const stages = stageRows ? toStageMap(stageRows) : {};
  return {
    ...base,
    brief: base.brief as JsonObject,
    currentStage: base.currentStage as WorkflowStage,
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
    state: job.state as StageState,
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
  createdAt: Date;
}): WorkflowArtifact {
  return { ...artifact, provenance: artifact.provenance as JsonObject };
}

function toWorkflowDelivery(delivery: {
  id: string;
  runId: string;
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
  if (review.decision !== input.decision) {
    throw new WorkflowConflictError('Review decision conflicts with the existing review');
  }

  return review;
}
