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
  attempt: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
}).strict();

export const jobResultSchema = z.object({
  jobId: z.string().uuid(),
  packageId: z.string().uuid(),
  stage: workflowStageSchema,
  state: stageStateSchema,
  completedAt: z.string().datetime(),
  outputChecksum: checksumSchema.nullable(),
  error: z.string().min(1).nullable(),
}).strict();

export const createRunRequestSchema = z.object({
  title: z.string().trim().min(1),
  locale: z.string().trim().min(1),
  brief: z.record(z.unknown()),
}).strict();

export const claimJobRequestSchema = z.object({
  leaseSeconds: z.number().int().positive(),
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

export const reviewDecisionSchema = z.enum(['approve', 'request_changes']);

export const reviewRunRequestSchema = z.object({
  decision: reviewDecisionSchema,
  packageChecksum: checksumSchema,
  reviewerId: z.string().trim().min(1),
  comment: z.string().trim().min(1).optional(),
}).strict().superRefine((input, refinement) => {
  if (input.decision === 'request_changes' && !input.comment) {
    refinement.addIssue({ code: z.ZodIssueCode.custom, message: 'Changes requested require a comment', path: ['comment'] });
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
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;
export type ReviewRunRequest = z.infer<typeof reviewRunRequestSchema>;
export type ReviewRunResponse = z.infer<typeof reviewRunResponseSchema>;
