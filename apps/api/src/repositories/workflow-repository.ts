import { randomUUID } from 'node:crypto';

import type {
  JobClaim,
  JobResult,
  StageState,
  WorkflowStage,
} from '@knowledge-bits/contracts';
import { Prisma, PrismaClient } from '@prisma/client';

type JsonObject = Record<string, unknown>;

export interface WorkflowRun {
  id: string;
  title: string;
  locale: string;
  brief: JsonObject;
  currentStage: WorkflowStage;
  currentRevision: number;
  createdAt: Date;
  updatedAt: Date;
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
  leaseSeconds: number;
  now?: Date;
}

export interface CompleteJobInput {
  workerId: string;
  result: JobResult;
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
  getRun(id: string): Promise<WorkflowRun | null>;
  queueJob(input: QueueJobInput): Promise<WorkflowJob>;
  claimJob(input: ClaimJobInput): Promise<JobClaim | null>;
  completeJob(input: CompleteJobInput): Promise<JobResult>;
  releaseExpiredLeases(input?: { now?: Date }): Promise<number>;
  recordArtifact(input: RecordArtifactInput): Promise<WorkflowArtifact>;
  recordReview(input: RecordReviewInput): Promise<WorkflowReview>;
  recordDelivery(input: RecordDeliveryInput): Promise<WorkflowDelivery>;
}

export class WorkflowConflictError extends Error {}

export class WorkflowRepository implements WorkflowStore {
  constructor(private readonly store: WorkflowStore) {}

  createRun(input: CreateRunInput): Promise<WorkflowRun> {
    return this.store.createRun(input);
  }

  getRun(id: string): Promise<WorkflowRun | null> {
    return this.store.getRun(id);
  }

  queueJob(input: QueueJobInput): Promise<WorkflowJob> {
    return this.store.queueJob(input);
  }

  claimJob(input: ClaimJobInput): Promise<JobClaim | null> {
    return this.store.claimJob(input);
  }

  completeJob(input: CompleteJobInput): Promise<JobResult> {
    return this.store.completeJob(input);
  }

  releaseExpiredLeases(input?: { now?: Date }): Promise<number> {
    return this.store.releaseExpiredLeases(input);
  }

  recordArtifact(input: RecordArtifactInput): Promise<WorkflowArtifact> {
    return this.store.recordArtifact(input);
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
          })),
        },
      },
    });

    return toWorkflowRun(run);
  }

  async getRun(id: string): Promise<WorkflowRun | null> {
    const run = await this.prisma.run.findUnique({ where: { id } });
    return run ? toWorkflowRun(run) : null;
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
    assertLeaseSeconds(input.leaseSeconds);
    const claimedAt = input.now ?? new Date();
    const leaseExpiresAt = new Date(claimedAt.getTime() + input.leaseSeconds * 1_000);
    const rows = await this.prisma.$queryRaw<ClaimedJobRow[]>(Prisma.sql`
      UPDATE "Job"
      SET "state" = 'running',
          "leaseOwner" = ${input.workerId},
          "leaseExpiresAt" = ${leaseExpiresAt},
          "attempt" = "attempt" + 1,
          "updatedAt" = ${claimedAt}
      WHERE "id" = (
        SELECT "id"
        FROM "Job"
        WHERE "state" = 'queued' AND "availableAt" <= ${claimedAt}
        ORDER BY "availableAt" ASC, "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      ) AND "state" = 'queued'
      RETURNING "id", "runId", "stage", "attempt", "leaseExpiresAt"
    `);
    const row = rows[0];

    if (!row) return null;

    return {
      jobId: row.id,
      packageId: row.runId,
      stage: row.stage as WorkflowStage,
      claimedBy: input.workerId,
      claimedAt: claimedAt.toISOString(),
      leaseExpiresAt: row.leaseExpiresAt.toISOString(),
      attempt: row.attempt,
    };
  }

  async completeJob(input: CompleteJobInput): Promise<JobResult> {
    const completedAt = new Date(input.result.completedAt);
    if (Number.isNaN(completedAt.getTime())) throw new TypeError('Job completion time must be valid');

    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE "Job"
      SET "state" = ${input.result.state},
          "result" = CAST(${JSON.stringify(input.result)} AS jsonb),
          "leaseOwner" = NULL,
          "leaseExpiresAt" = NULL,
          "updatedAt" = ${completedAt}
      WHERE "id" = ${input.result.jobId}
        AND "runId" = ${input.result.packageId}
        AND "stage" = ${input.result.stage}
        AND "state" = 'running'
        AND "leaseOwner" = ${input.workerId}
        AND "leaseExpiresAt" > ${completedAt}
      RETURNING "id"
    `);

    if (!rows[0]) throw new WorkflowConflictError('Job lease is no longer valid');
    return input.result;
  }

  releaseExpiredLeases(input: { now?: Date } = {}): Promise<number> {
    const now = input.now ?? new Date();

    return this.prisma.$executeRaw(Prisma.sql`
      UPDATE "Job"
      SET "state" = 'queued',
          "leaseOwner" = NULL,
          "leaseExpiresAt" = NULL,
          "availableAt" = ${now},
          "updatedAt" = ${now}
      WHERE "state" = 'running' AND "leaseExpiresAt" <= ${now}
    `);
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
      throwUniqueConflict(error, 'Artifact storage key already exists');
    }
  }

  async recordReview(input: RecordReviewInput): Promise<WorkflowReview> {
    try {
      const review = await this.prisma.review.create({
        data: input,
      });

      return review;
    } catch (error) {
      throwUniqueConflict(error, 'Review already exists for this run, revision, and checksum');
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
  private readonly artifactsByStorageKey = new Map<string, WorkflowArtifact>();
  private readonly reviewsByIdentity = new Map<string, WorkflowReview>();
  private readonly deliveriesByIdempotencyKey = new Map<string, WorkflowDelivery>();
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;

  constructor(options: InMemoryWorkflowStoreOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? randomUUID;
  }

  async createRun(input: CreateRunInput): Promise<WorkflowRun> {
    const now = this.clock();
    const run: WorkflowRun = {
      id: input.id ?? this.idGenerator(),
      title: input.title,
      locale: input.locale,
      brief: input.brief,
      currentStage: input.currentStage ?? 'research',
      currentRevision: input.currentRevision ?? 1,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(run.id, run);
    return run;
  }

  async getRun(id: string): Promise<WorkflowRun | null> {
    return this.runs.get(id) ?? null;
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
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    this.jobsByIdempotencyKey.set(job.idempotencyKey, job.id);
    return job;
  }

  async claimJob(input: ClaimJobInput): Promise<JobClaim | null> {
    assertLeaseSeconds(input.leaseSeconds);
    const claimedAt = input.now ?? this.clock();
    const job = [...this.jobs.values()]
      .filter((candidate) => candidate.state === 'queued' && candidate.availableAt <= claimedAt)
      .sort((left, right) => left.availableAt.getTime() - right.availableAt.getTime()
        || left.createdAt.getTime() - right.createdAt.getTime())[0];

    if (!job) return null;

    job.state = 'running';
    job.leaseOwner = input.workerId;
    job.leaseExpiresAt = new Date(claimedAt.getTime() + input.leaseSeconds * 1_000);
    job.attempt += 1;
    job.updatedAt = claimedAt;

    return {
      jobId: job.id,
      packageId: job.runId,
      stage: job.stage,
      claimedBy: input.workerId,
      claimedAt: claimedAt.toISOString(),
      leaseExpiresAt: job.leaseExpiresAt.toISOString(),
      attempt: job.attempt,
    };
  }

  async completeJob(input: CompleteJobInput): Promise<JobResult> {
    const completedAt = new Date(input.result.completedAt);
    const job = this.jobs.get(input.result.jobId);
    if (
      Number.isNaN(completedAt.getTime())
      || !job
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
        released += 1;
      }
    }

    return released;
  }

  async recordArtifact(input: RecordArtifactInput): Promise<WorkflowArtifact> {
    this.requireRun(input.runId);
    if (this.artifactsByStorageKey.has(input.storageKey)) {
      throw new WorkflowConflictError('Artifact storage key already exists');
    }

    const artifact: WorkflowArtifact = {
      ...input,
      id: input.id ?? this.idGenerator(),
      createdAt: this.clock(),
    };
    this.artifactsByStorageKey.set(artifact.storageKey, artifact);
    return artifact;
  }

  async recordReview(input: RecordReviewInput): Promise<WorkflowReview> {
    this.requireRun(input.runId);
    const identity = reviewIdentity(input);
    if (this.reviewsByIdentity.has(identity)) {
      throw new WorkflowConflictError('Review already exists for this run, revision, and checksum');
    }

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
}

function assertLeaseSeconds(leaseSeconds: number): void {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0) {
    throw new TypeError('Lease seconds must be a positive integer');
  }
}

function reviewIdentity(input: RecordReviewInput): string {
  return `${input.runId}:${input.revision}:${input.packageChecksum}`;
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
  createdAt: Date;
  updatedAt: Date;
}): WorkflowRun {
  return {
    ...run,
    brief: run.brief as JsonObject,
    currentStage: run.currentStage as WorkflowStage,
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
  createdAt: Date;
  updatedAt: Date;
}): WorkflowJob {
  return {
    ...job,
    stage: job.stage as WorkflowStage,
    state: job.state as StageState,
    input: job.input as JsonObject,
    result: job.result as JobResult | null,
  };
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
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
    throw new WorkflowConflictError(message);
  }

  throw error;
}
