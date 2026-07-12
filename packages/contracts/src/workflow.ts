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
  stages: z.record(workflowStageSnapshotSchema),
  nextRetryAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export type WorkflowStage = z.infer<typeof workflowStageSchema>;
export type StageState = z.infer<typeof stageStateSchema>;
export type Checksum = z.infer<typeof checksumSchema>;
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;
export type JobClaim = z.infer<typeof jobClaimSchema>;
export type JobResult = z.infer<typeof jobResultSchema>;
export type CreateRunRequest = z.infer<typeof createRunRequestSchema>;
export type ClaimJobRequest = z.infer<typeof claimJobRequestSchema>;
export type ReportJobResultRequest = z.infer<typeof reportJobResultRequestSchema>;
export type WorkflowRunResponse = z.infer<typeof workflowRunResponseSchema>;
