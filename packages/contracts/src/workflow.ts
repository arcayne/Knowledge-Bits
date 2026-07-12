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

export type WorkflowStage = z.infer<typeof workflowStageSchema>;
export type StageState = z.infer<typeof stageStateSchema>;
export type Checksum = z.infer<typeof checksumSchema>;
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;
export type JobClaim = z.infer<typeof jobClaimSchema>;
export type JobResult = z.infer<typeof jobResultSchema>;
