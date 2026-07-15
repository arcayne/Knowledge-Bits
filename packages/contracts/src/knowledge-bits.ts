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

export const legacyNugletLessonTargetSchema = z.object({
  kind: z.literal('nuglet.lesson.v1'),
  schemaVersion: z.literal('1.0.0'),
  payload: nugletLessonV1PayloadSchema,
}).strict();

export const storyPlaybookLearnerContentPathSchema = z.enum([
  'identity.title',
  'learning.centralIdea',
  'learning.whyItMatters',
  'learning.oneLineToKeep',
  'learning.action',
  'read.story',
  'read.playbook',
  'visual',
  'listen.brief',
  'listen.discussion',
  'quiz',
]);

const claimReferencesSchema = z.array(z.string().uuid());

const storyBlockSchema = z.object({
  type: z.enum(['opening', 'turning_point', 'evidence', 'practical_bridge']),
  text: z.string().trim().min(1),
  claimRefs: claimReferencesSchema,
}).strict();

const storySchema = z.object({
  title: z.string().trim().min(1),
  estimatedMinutes: z.number().int().positive(),
  blocks: z.array(storyBlockSchema).min(1),
}).strict();

const playbookStepSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
  claimRefs: claimReferencesSchema,
}).strict();

const playbookSchema = z.object({
  title: z.string().trim().min(1),
  estimatedMinutes: z.number().int().positive(),
  principle: z.string().trim().min(1),
  whyItMatters: z.string().trim().min(1),
  steps: z.array(playbookStepSchema).min(3).max(5),
  example: z.object({
    title: z.string().trim().min(1),
    body: z.string().trim().min(1),
    claimRefs: claimReferencesSchema,
  }).strict(),
  watchOuts: z.array(z.string().trim().min(1)).min(1),
  action: z.string().trim().min(1),
}).strict();

const identitySchema = z.object({
  locale: z.string().trim().min(1),
  topic: z.object({
    label: z.string().trim().min(1),
    categoryId: z.string().trim().min(1).nullable(),
  }).strict(),
  tags: z.array(z.string().trim().min(1)),
  title: z.string().trim().min(1),
  deck: z.string().trim().min(1),
  slugSuggestion: z.string().trim().min(1),
}).strict();

const learningSchema = z.object({
  centralIdea: z.string().trim().min(1),
  whyItMatters: z.string().trim().min(1),
  oneLineToKeep: z.string().trim().min(1),
  action: z.object({
    label: z.string().trim().min(1),
    instruction: z.string().trim().min(1),
  }).strict(),
}).strict();

const heroBriefSchema = z.object({
  altText: z.string().trim().min(1),
  accessibilityPurpose: z.enum(['informative', 'decorative']),
  mediaBrief: z.object({
    concept: z.string().trim().min(1),
    metaphor: z.string().trim().min(1),
    compositionFamily: z.string().trim().min(1),
  }).strict(),
}).strict();

const visualBriefSchema = z.object({
  title: z.string().trim().min(1),
  altText: z.string().trim().min(1),
  textEquivalent: z.array(z.string().trim().min(1)).min(1),
  claimRefs: claimReferencesSchema,
  mediaBrief: z.object({
    objective: z.string().trim().min(1),
    structure: z.string().trim().min(1),
  }).strict(),
}).strict();

const audioEditorialBriefSchema = z.object({
  editorialBrief: z.object({
    objective: z.string().trim().min(1),
    tone: z.string().trim().min(1),
    keyPoints: z.array(z.string().trim().min(1)).min(1),
  }).strict(),
}).strict();

const quizQuestionSchema = z.object({
  id: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  options: z.array(z.object({
    id: z.string().trim().min(1),
    text: z.string().trim().min(1),
  }).strict()).min(3).max(4),
  correctOptionId: z.string().trim().min(1),
  rationale: z.string().trim().min(1),
  reviewConcept: z.string().trim().min(1),
  claimRefs: claimReferencesSchema,
}).strict().superRefine(({ correctOptionId, options }, context) => {
  const optionIds = new Set(options.map((option) => option.id));
  if (optionIds.size !== options.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Quiz option IDs must be unique',
      path: ['options'],
    });
  }
  if (!optionIds.has(correctOptionId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Correct option must reference a supplied option',
      path: ['correctOptionId'],
    });
  }
});

const publicSourceSchema = z.object({
  evidenceSourceId: z.string().trim().min(1),
  label: z.string().trim().min(1),
  publisher: z.string().trim().min(1),
}).strict();

const storyPlaybookClaimCoverageSchema = z.array(z.object({
  path: storyPlaybookLearnerContentPathSchema,
  claimIds: z.array(z.string().uuid()).min(1),
}).strict());

const storyPlaybookBaseShape = {
  // Keeps legacy consumers that read payload.title type-safe while the
  // canonical Story/Playbook title remains identity.title.
  title: z.never().optional(),
  contentModel: z.literal('story-playbook.v1'),
  identity: identitySchema,
  learning: learningSchema,
  read: z.object({
    story: storySchema,
    playbook: playbookSchema,
  }).strict(),
  quiz: z.object({
    questions: z.array(quizQuestionSchema).length(3),
  }).strict(),
  publicSources: z.array(publicSourceSchema).min(1),
  claims: z.array(claimSchema).min(1),
  claimCoverage: storyPlaybookClaimCoverageSchema,
};

function validateStoryPlaybookClaims(
  value: {
    claims: z.infer<typeof claimSchema>[];
    claimCoverage: z.infer<typeof storyPlaybookClaimCoverageSchema>;
  },
  context: z.RefinementCtx,
): void {
  const claimIds = new Set(value.claims.map((claim) => claim.claimId));
  const coveredPaths = new Set(value.claimCoverage.map((entry) => entry.path));
  for (const path of storyPlaybookLearnerContentPathSchema.options) {
    if (!coveredPaths.has(path)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Claim coverage is required for ${path}`,
        path: ['claimCoverage'],
      });
    }
  }
  if (coveredPaths.size !== value.claimCoverage.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Claim coverage paths must be unique',
      path: ['claimCoverage'],
    });
  }
  value.claimCoverage.forEach((entry, coverageIndex) => {
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
}

export const storyPlaybookDraftSchema = z.object({
  ...storyPlaybookBaseShape,
  materialization: z.literal('draft'),
  hero: heroBriefSchema,
  visual: visualBriefSchema,
  listen: z.object({
    brief: audioEditorialBriefSchema,
    discussion: audioEditorialBriefSchema,
  }).strict(),
}).strict().superRefine(validateStoryPlaybookClaims);

const pointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
}).strict();

const transcriptSchema = z.object({
  source: z.literal('final_audio_bytes'),
  text: z.string().trim().min(1),
  checksum: checksumSchema,
}).strict();

const finalAudioSchema = z.object({
  editorialBrief: audioEditorialBriefSchema.shape.editorialBrief,
  asset: artifactReferenceSchema,
  durationSeconds: z.number().positive(),
  transcript: transcriptSchema,
}).strict();

export const storyPlaybookPayloadSchema = z.object({
  ...storyPlaybookBaseShape,
  materialization: z.literal('materialized'),
  hero: z.object({
    ...heroBriefSchema.shape,
    asset: artifactReferenceSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    focalPoint: pointSchema,
    cropSafeArea: z.object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      width: z.number().positive().max(1),
      height: z.number().positive().max(1),
    }).strict(),
  }).strict(),
  visual: z.object({
    ...visualBriefSchema.shape,
    asset: artifactReferenceSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }).strict(),
  listen: z.object({
    brief: finalAudioSchema,
    discussion: finalAudioSchema,
  }).strict(),
}).strict().superRefine(validateStoryPlaybookClaims);

export const storyPlaybookNugletLessonTargetSchema = z.object({
  kind: z.literal('nuglet.lesson.v1'),
  schemaVersion: z.literal('1.1.0'),
  payload: z.union([storyPlaybookDraftSchema, storyPlaybookPayloadSchema]),
}).strict();

export const nugletLessonTargetSchema = z.discriminatedUnion('schemaVersion', [
  legacyNugletLessonTargetSchema,
  storyPlaybookNugletLessonTargetSchema,
]);

const compatibleNugletLessonTargetSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if ('schemaVersion' in value || !('payload' in value)) return value;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== 'nuglet.lesson.v1') return value;
  if (!nugletLessonV1PayloadSchema.safeParse(candidate.payload).success) return value;
  return { ...candidate, schemaVersion: '1.0.0' };
}, nugletLessonTargetSchema);

export const knowledgeBitsContentSchema = z.object({
  schemaVersion: z.literal('knowledge-bits.content.v1'),
  target: compatibleNugletLessonTargetSchema,
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
  target: compatibleNugletLessonTargetSchema,
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
type LegacyUnversionedNugletLessonTarget = Omit<z.infer<typeof legacyNugletLessonTargetSchema>, 'schemaVersion'>;
export type KnowledgeBitsContent = z.infer<typeof knowledgeBitsContentSchema> | {
  schemaVersion: 'knowledge-bits.content.v1';
  target: LegacyUnversionedNugletLessonTarget;
};
export type NugletLessonV1Payload = z.infer<typeof nugletLessonV1PayloadSchema>;
export type StoryPlaybookDraft = z.infer<typeof storyPlaybookDraftSchema>;
export type StoryPlaybookPayload = z.infer<typeof storyPlaybookPayloadSchema>;
export type NugletLessonTarget = z.infer<typeof nugletLessonTargetSchema>;
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
