import { z } from 'zod';

import {
  artifactReferenceSchema,
  checksumSchema,
  reviewStatusSchema,
  workflowStageSchema,
} from './workflow.js';

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

const citationSchema = z.object({
  // Source IDs are stable pipeline identifiers. They may be derived from a
  // URL when a provider returns no durable source UUID.
  sourceId: z.string().trim().min(1),
  snapshotArtifactId: z.string().uuid(),
  excerpt: z.string().min(1),
}).strict();

const claimSchema = z.object({
  claimId: z.string().uuid(),
  statement: z.string().min(1),
  citations: z.array(citationSchema).min(1),
}).strict();

const sourceReadabilitySchema = z.object({
  passed: z.boolean(),
  reason: z.string().min(1).nullable(),
}).strict();

const sourceCredibilitySchema = z.object({
  passed: z.boolean(),
  policy: z.string().min(1),
  reason: z.string().min(1).nullable(),
}).strict();

const sourceIdentitySchema = {
  sourceId: z.string().trim().min(1),
  url: z.string().url(),
  title: z.string().min(1),
};

const acceptedSourceSchema = z.object({
  ...sourceIdentitySchema,
  retrievedAt: z.string().datetime(),
  snapshot: artifactReferenceSchema,
  readability: sourceReadabilitySchema,
  credibility: sourceCredibilitySchema,
}).strict();

const rejectedSourceSchema = z.object({
  ...sourceIdentitySchema,
  readability: sourceReadabilitySchema,
  credibility: sourceCredibilitySchema,
}).strict();

export const knowledgeBitsEvidenceSchema = z.object({
  schemaVersion: z.literal('knowledge-bits.evidence.v1'),
  acceptedSources: z.array(acceptedSourceSchema).min(1),
  rejectedSources: z.array(rejectedSourceSchema),
  coverageGaps: z.array(z.object({
    topic: z.string().min(1),
    reason: z.string().min(1),
  }).strict()),
  claims: z.array(claimSchema).min(1),
}).strict().superRefine(({ acceptedSources, claims, rejectedSources }, context) => {
  const acceptedById = new Map(acceptedSources.map((source) => [source.sourceId, source]));

  acceptedSources.forEach((source, sourceIndex) => {
    if (!source.readability.passed || !source.credibility.passed) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Accepted source requires passing readability and credibility decisions',
        path: ['acceptedSources', sourceIndex],
      });
    }
    if (source.snapshot.kind !== 'source_snapshot') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Accepted source requires an immutable source snapshot artifact',
        path: ['acceptedSources', sourceIndex, 'snapshot', 'kind'],
      });
    }
  });

  rejectedSources.forEach((source, sourceIndex) => {
    if (source.readability.passed && source.credibility.passed) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Rejected source requires a failed readability or credibility decision',
        path: ['rejectedSources', sourceIndex],
      });
    }
  });

  claims.forEach((claim, claimIndex) => {
    claim.citations.forEach((citation, citationIndex) => {
      const source = acceptedById.get(citation.sourceId);
      if (!source || source.snapshot.artifactId !== citation.snapshotArtifactId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Citation must resolve to an accepted snapshot',
          path: ['claims', claimIndex, 'citations', citationIndex, 'snapshotArtifactId'],
        });
      }
    });
  });
});

export const learnerContentPathSchema = z.enum([
  'title',
  'takeaway',
  'action',
  'depths.quick',
  'depths.core',
  'depths.deep',
]);

export const nugletLessonV1PayloadSchema = z.object({
  title: z.string().trim().min(1),
  takeaway: z.string().trim().min(1),
  action: z.string().trim().min(1),
  depths: z.object({
    quick: z.string().trim().min(1),
    core: z.string().trim().min(1),
    deep: z.string().trim().min(1),
  }).strict(),
  claims: z.array(claimSchema).min(1),
  claimCoverage: z.array(z.object({
    path: learnerContentPathSchema,
    claimIds: z.array(z.string().uuid()).min(1),
  }).strict()),
}).strict().superRefine(({ claims, claimCoverage }, context) => {
  const claimIds = new Set(claims.map((claim) => claim.claimId));
  const coveredPaths = new Set(claimCoverage.map((entry) => entry.path));
  for (const path of learnerContentPathSchema.options) {
    if (!coveredPaths.has(path)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Claim coverage is required for ${path}`,
        path: ['claimCoverage'],
      });
    }
  }
  if (coveredPaths.size !== claimCoverage.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Claim coverage paths must be unique',
      path: ['claimCoverage'],
    });
  }
  claimCoverage.forEach((entry, coverageIndex) => {
    entry.claimIds.forEach((claimId, claimIndex) => {
      if (!claimIds.has(claimId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Claim coverage must reference a supplied claim',
          path: ['claimCoverage', coverageIndex, 'claimIds', claimIndex],
        });
      }
    });
  });
});

export const knowledgeBitsContentSchema = z.object({
  schemaVersion: z.literal('knowledge-bits.content.v1'),
  target: z.object({
    kind: z.literal('nuglet.lesson.v1'),
    payload: nugletLessonV1PayloadSchema,
  }).strict(),
}).strict();

export const knowledgeBitsQaSchema = z.object({
  deterministic: z.object({
    passed: z.boolean(),
    contentChecksum: checksumSchema,
    findings: z.array(z.object({
      code: z.string().min(1),
      message: z.string().min(1),
    }).strict()),
  }).strict(),
  editorial: z.object({
    summary: z.string().min(1),
    findings: z.array(z.object({
      code: z.string().min(1),
      severity: z.enum(['critical', 'major', 'minor']),
      blocking: z.boolean(),
      message: z.string().min(1),
    }).strict()),
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
    payload: nugletLessonV1PayloadSchema,
  }).strict(),
  surfaces: z.object({
    manifest: artifactReferenceSchema,
    evidence: artifactReferenceSchema,
    content: artifactReferenceSchema,
    workflow: artifactReferenceSchema,
  }).strict(),
  evidence: knowledgeBitsEvidenceSchema,
  qa: knowledgeBitsQaSchema,
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
export type NugletLessonV1Payload = z.infer<typeof nugletLessonV1PayloadSchema>;
export type KnowledgeBitsManifest = z.infer<typeof knowledgeBitsManifestSchema>;
export type KnowledgeBits = z.infer<typeof knowledgeBitsSchema>;
export type KnowledgeBitsQa = z.infer<typeof knowledgeBitsQaSchema>;
export type ArtifactPrepareRequest = z.infer<typeof artifactPrepareRequestSchema>;
export type ArtifactPrepareResponse = z.infer<typeof artifactPrepareResponseSchema>;
export type ArtifactCompleteRequest = z.infer<typeof artifactCompleteRequestSchema>;

export const reviewPackageVersionSchema = z.object({
  id: z.string().min(1),
  schemaVersion: z.literal('knowledge-bits.review-package.v1'),
  packageId: packageIdSchema,
  revision: z.number().int().positive(),
  packageChecksum: checksumSchema,
  adapterVersion: z.string().min(1),
  locale: z.string().min(1),
  owner: z.string().min(1),
  usageRights: z.record(z.unknown()),
  content: knowledgeBitsContentSchema,
  evidence: knowledgeBitsEvidenceSchema,
  qa: knowledgeBitsQaSchema,
  artifactInventory: z.array(artifactReferenceSchema),
}).strict();

export type ReviewPackageVersion = z.infer<typeof reviewPackageVersionSchema>;

const reviewAssetSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('missing'), artifactId: z.null(), mediaType: z.null(), previewPath: z.null() }).strict(),
  z.object({ state: z.literal('available'), artifactId: z.string().uuid(), mediaType: z.string().min(1), previewPath: z.string().min(1) }).strict(),
]);

export const reviewReadModelSchema = z.object({
  runId: packageIdSchema,
  title: z.string().min(1),
  currentStage: workflowStageSchema,
  currentRevision: z.number().int().positive(),
  reviewStatus: reviewStatusSchema,
  currentPackageChecksum: checksumSchema.nullable(),
  decisionAllowed: z.boolean(),
  issues: z.array(z.string().min(1)),
  package: reviewPackageVersionSchema.nullable(),
  assets: z.object({
    hero: reviewAssetSchema,
    infographic: reviewAssetSchema,
    audio: reviewAssetSchema,
  }).strict(),
}).strict();

export type ReviewReadModel = z.infer<typeof reviewReadModelSchema>;
