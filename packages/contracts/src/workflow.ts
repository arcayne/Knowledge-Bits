import { z } from 'zod';

export const workflowStageSchema = z.enum([
  'research',
  'create',
  'check',
  'produce_assets',
  'human_review',
  'deliver',
]);

export const stageStateSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'needs_human',
  'done',
]);

export const reviewStatusSchema = z.enum([
  'pending',
  'approved',
  'changes_requested',
  'rejected',
]);

export const checksumSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const artifactReferenceSchema = z.object({
  artifactId: z.string().uuid(),
  kind: z.string().min(1),
  mediaType: z.string().min(1),
  checksum: checksumSchema,
  storageKey: z.string().min(1),
  byteSize: z.number().int().positive(),
  createdAt: z.string().datetime(),
  provider: z.string().min(1),
  inputChecksum: checksumSchema.nullable(),
}).strict();

export const jobClaimSchema = z.object({
  jobId: z.string().uuid(),
  packageId: z.string().uuid(),
  stage: workflowStageSchema,
  claimedBy: z.string().min(1),
  claimedAt: z.string().datetime(),
  leaseExpiresAt: z.string().datetime(),
  executionDeadlineAt: z.string().datetime(),
  attempt: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  input: z.record(z.unknown()),
  deliveryId: z.string().uuid().optional(),
  packageVersionId: z.string().uuid().optional(),
  packageChecksum: checksumSchema.optional(),
}).strict().superRefine((claim, context) => {
  if (claim.stage === 'deliver' && (!claim.deliveryId || !claim.packageVersionId || !claim.packageChecksum)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Delivery claims require immutable package identity',
    });
  }
});

export const jobResultSchema = z.object({
  jobId: z.string().uuid(),
  packageId: z.string().uuid(),
  stage: workflowStageSchema,
  state: stageStateSchema,
  completedAt: z.string().datetime(),
  outputChecksum: checksumSchema.nullable(),
  error: z.string().min(1).nullable(),
  needsHumanKind: z.enum(['configuration', 'quality']).optional(),
}).strict().superRefine((result, context) => {
  if (result.state === 'needs_human' && !result.needsHumanKind) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'needsHumanKind is required for needs_human results',
      path: ['needsHumanKind'],
    });
  }
  if (result.state !== 'needs_human' && result.needsHumanKind) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'needsHumanKind is only allowed for needs_human results',
      path: ['needsHumanKind'],
    });
  }
});

export const createRunRequestSchema = z.object({
  title: z.string().trim().min(1),
  locale: z.string().trim().min(1),
  brief: z.record(z.unknown()),
  notebookLmNotebookId: z.string().trim().min(1).optional(),
}).strict();

export const claimJobRequestSchema = z.object({
  leaseSeconds: z.number().int().positive(),
  preferredRunId: z.string().uuid().optional(),
}).strict();

export const reportJobResultRequestSchema = z.object({
  result: jobResultSchema,
  retryAt: z.string().datetime().optional(),
}).strict().superRefine((input, refinement) => {
  if (input.result.state === 'waiting' && !input.retryAt) {
    refinement.addIssue({ code: z.ZodIssueCode.custom, message: 'Waiting results require retryAt' });
  }
  if (input.result.state !== 'waiting' && input.retryAt) {
    refinement.addIssue({ code: z.ZodIssueCode.custom, message: 'Only waiting results may include retryAt' });
  }
});

export const workflowStageSnapshotSchema = z.object({
  name: workflowStageSchema,
  state: stageStateSchema,
  reason: z.string().nullable(),
  attempt: z.number().int().nonnegative(),
  revisionAttempts: z.number().int().nonnegative(),
}).strict();

export const workflowRunResponseSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  locale: z.string().min(1),
  brief: z.record(z.unknown()),
  notebookLmNotebookId: z.string().min(1).nullable(),
  currentStage: workflowStageSchema,
  currentRevision: z.number().int().positive(),
  packageChecksum: checksumSchema.nullable(),
  approvedChecksum: checksumSchema.nullable(),
  reviewStatus: reviewStatusSchema,
  stages: z.record(workflowStageSnapshotSchema),
  nextRetryAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const pipelineRunSummarySchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  locale: z.string().min(1),
  classification: z.enum(['active', 'deliver', 'completed', 'rejected', 'duplicate']),
  duplicateOf: z.string().uuid().nullable(),
  currentStage: workflowStageSchema,
  currentState: stageStateSchema,
  reason: z.string().nullable(),
  currentRevision: z.number().int().positive(),
  currentAttempt: z.number().int().nonnegative(),
  nextRetryAt: z.string().datetime().nullable(),
  reviewStatus: reviewStatusSchema,
  delivery: z.object({
    state: z.enum(['queued', 'running', 'waiting', 'failed', 'verifying', 'succeeded', 'needs_human', 'superseded']),
    attempts: z.number().int().nonnegative(),
    target: z.string().min(1),
    nextAttemptAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime(),
  }).strict().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const pipelineReadModelSchema = z.object({
  daily: z.object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    timezone: z.literal('Europe/Madrid'),
    target: z.number().int().positive(),
    started: z.number().int().nonnegative(),
    readyForReview: z.number().int().nonnegative(),
    approvedInFlight: z.number().int().nonnegative(),
    delivered: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
  }).strict(),
  counts: z.object({
    research: z.number().int().nonnegative(),
    create: z.number().int().nonnegative(),
    check: z.number().int().nonnegative(),
    produce_assets: z.number().int().nonnegative(),
    human_review: z.number().int().nonnegative(),
    deliver: z.number().int().nonnegative(),
    delivering: z.number().int().nonnegative(),
    needsHuman: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    retrying: z.number().int().nonnegative(),
  }).strict(),
  runs: z.array(pipelineRunSummarySchema),
}).strict();

export const reviewDecisionSchema = z.enum(['approve', 'request_changes', 'reject']);

export const reviewRunRequestSchema = z.object({
  decision: reviewDecisionSchema,
  packageChecksum: checksumSchema,
  comment: z.string().trim().min(1).optional(),
}).strict().superRefine((input, refinement) => {
  if ((input.decision === 'request_changes' || input.decision === 'reject') && !input.comment) {
    refinement.addIssue({ code: z.ZodIssueCode.custom, message: 'Changes and rejections require a comment', path: ['comment'] });
  }
  if (input.decision === 'approve' && input.comment !== undefined) {
    refinement.addIssue({ code: z.ZodIssueCode.custom, message: 'Approval does not accept a comment', path: ['comment'] });
  }
});

export const reviewRunResponseSchema = z.object({
  runId: z.string().uuid(),
  currentStage: workflowStageSchema,
  state: stageStateSchema,
  currentRevision: z.number().int().positive(),
  reviewStatus: reviewStatusSchema,
  packageChecksum: checksumSchema,
  approvedChecksum: checksumSchema.nullable(),
}).strict();


export type WorkflowStage = z.infer<typeof workflowStageSchema>;
export type StageState = z.infer<typeof stageStateSchema>;
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;
export type Checksum = z.infer<typeof checksumSchema>;
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;
export type JobClaim = z.infer<typeof jobClaimSchema>;
export type JobResult = z.infer<typeof jobResultSchema>;
export type CreateRunRequest = z.infer<typeof createRunRequestSchema>;
export type ClaimJobRequest = z.infer<typeof claimJobRequestSchema>;
export type ReportJobResultRequest = z.infer<typeof reportJobResultRequestSchema>;
export type WorkflowRunResponse = z.infer<typeof workflowRunResponseSchema>;
export type PipelineRunSummary = z.infer<typeof pipelineRunSummarySchema>;
export type PipelineReadModel = z.infer<typeof pipelineReadModelSchema>;
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;
export type ReviewRunRequest = z.infer<typeof reviewRunRequestSchema>;
export type ReviewRunResponse = z.infer<typeof reviewRunResponseSchema>;
