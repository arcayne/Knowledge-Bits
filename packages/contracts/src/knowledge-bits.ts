import { z } from 'zod';

import { artifactReferenceSchema, checksumSchema } from './workflow.js';

const packageIdSchema = z.string().uuid();

export const artifactPrepareRequestSchema = z.object({
  jobId: z.string().uuid(),
  runId: packageIdSchema,
  revision: z.number().int().positive(),
  kind: z.string().trim().min(1),
  mediaType: z.string().trim().min(1),
}).strict();

export const artifactPrepareResponseSchema = z.object({
  artifactId: z.string().uuid(),
  storageKey: z.string().min(1),
  uploadUrl: z.string().url(),
  requiredHeaders: z.record(z.string()),
}).strict();

export const artifactCompleteRequestSchema = z.object({
  jobId: z.string().uuid(),
  artifactId: z.string().uuid(),
  runId: packageIdSchema,
  revision: z.number().int().positive(),
  kind: z.string().trim().min(1),
  mediaType: z.string().trim().min(1),
  checksum: checksumSchema,
  byteSize: z.number().int().positive(),
  provider: z.string().trim().min(1),
  inputChecksum: checksumSchema.nullable(),
  provenance: z.record(z.unknown()),
}).strict();

const sourceSchema = z.object({
  sourceId: z.string().uuid(),
  url: z.string().url(),
  title: z.string().min(1),
  retrievedAt: z.string().datetime(),
  checksum: checksumSchema,
}).strict();

const citationSchema = z.object({
  sourceId: z.string().uuid(),
  excerpt: z.string().min(1),
}).strict();

const claimSchema = z.object({
  claimId: z.string().uuid(),
  statement: z.string().min(1),
  citations: z.array(citationSchema).min(1),
}).strict();

export const knowledgeBitsEvidenceSchema = z.object({
  schemaVersion: z.literal('knowledge-bits.evidence.v1'),
  sources: z.array(sourceSchema).min(1),
  claims: z.array(claimSchema).min(1),
}).strict().superRefine(({ claims, sources }, context) => {
  const sourceIds = new Set(sources.map(({ sourceId }) => sourceId));

  claims.forEach((claim, claimIndex) => {
    claim.citations.forEach((citation, citationIndex) => {
      if (!sourceIds.has(citation.sourceId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Citation source must exist in sources',
          path: ['claims', claimIndex, 'citations', citationIndex, 'sourceId'],
        });
      }
    });
  });
});

export const knowledgeBitsContentSchema = z.object({
  schemaVersion: z.literal('knowledge-bits.content.v1'),
  target: z.object({
    kind: z.literal('nuglet.lesson.v1'),
    payload: z.record(z.unknown()),
  }).strict(),
}).strict();

export const knowledgeBitsManifestSchema = z.object({
  schemaVersion: z.literal('knowledge-bits.manifest.v1'),
  packageId: packageIdSchema,
  revision: z.number().int().positive(),
  generatedAt: z.string().datetime(),
  packageChecksum: checksumSchema,
  surfaces: z.object({
    manifest: artifactReferenceSchema,
    evidence: artifactReferenceSchema,
    content: artifactReferenceSchema,
    workflow: artifactReferenceSchema,
  }).strict(),
}).strict();

const approvalSchema = z.object({
  status: z.enum(['unapproved', 'approved', 'changes_requested']),
  reviewerId: z.string().min(1).nullable(),
  decidedAt: z.string().datetime().nullable(),
  approvedChecksum: checksumSchema.nullable(),
  comment: z.string().nullable(),
}).strict();

export const knowledgeBitsSchema = z.object({
  schemaVersion: z.literal('knowledge-bits.package.v1'),
  packageId: packageIdSchema,
  revision: z.number().int().positive(),
  locale: z.string().min(1),
  owner: z.string().min(1),
  riskClass: z.enum(['low', 'medium', 'high']),
  target: z.object({
    kind: z.literal('nuglet.lesson.v1'),
    payload: z.record(z.unknown()),
  }).strict(),
  surfaces: z.object({
    manifest: artifactReferenceSchema,
    evidence: artifactReferenceSchema,
    content: artifactReferenceSchema,
    workflow: artifactReferenceSchema,
  }).strict(),
  evidence: knowledgeBitsEvidenceSchema,
  packageChecksum: checksumSchema,
  approval: approvalSchema,
}).strict().superRefine(({ approval, packageChecksum }, context) => {
  if (approval.status === 'approved' && approval.approvedChecksum !== packageChecksum) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Approved checksum must match package checksum',
      path: ['approval', 'approvedChecksum'],
    });
  }

  if (approval.status === 'changes_requested' && !approval.comment?.trim()) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Changes requested require a non-empty comment',
      path: ['approval', 'comment'],
    });
  }
});

export type KnowledgeBitsEvidence = z.infer<typeof knowledgeBitsEvidenceSchema>;
export type KnowledgeBitsContent = z.infer<typeof knowledgeBitsContentSchema>;
export type KnowledgeBitsManifest = z.infer<typeof knowledgeBitsManifestSchema>;
export type KnowledgeBits = z.infer<typeof knowledgeBitsSchema>;
export type ArtifactPrepareRequest = z.infer<typeof artifactPrepareRequestSchema>;
export type ArtifactPrepareResponse = z.infer<typeof artifactPrepareResponseSchema>;
export type ArtifactCompleteRequest = z.infer<typeof artifactCompleteRequestSchema>;
