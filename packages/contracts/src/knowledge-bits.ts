import { z } from 'zod';

import {
  artifactReferenceSchema,
  checksumSchema,
  createRunRequestSchema,
  reviewStatusSchema,
  workflowStageSchema,
  workflowRunResponseSchema,
} from './workflow.js';

const packageIdSchema = z.string().uuid();

const generationRecipeVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const generationRecipeChecksumSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const relativeArtifactPathSchema = z.string().trim().min(1).refine((value) => (
  !value.startsWith('/')
  && !value.includes('\\')
  && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
), 'must be a normalized relative path');

function generationRecipeBindingSchema(id: string) {
  return z.object({
    id: z.literal(id),
    version: generationRecipeVersionSchema,
    checksum: generationRecipeChecksumSchema,
  }).strict();
}

const genericGenerationRecipeBindingSchema = z.object({
  id: z.string().trim().min(1),
  version: generationRecipeVersionSchema,
  checksum: generationRecipeChecksumSchema,
}).strict();

const notebookLmExecutionEvidenceSchema = z.object({
  artifactId: z.string().trim().min(1),
  model: z.string().trim().min(1),
  notebookId: z.string().trim().min(1),
  prompt: z.object({
    bytesBase64: z.string().trim().min(1),
    checksum: generationRecipeChecksumSchema,
  }).strict(),
  provider: z.literal('notebooklm'),
  recipe: genericGenerationRecipeBindingSchema,
}).strict();

const baselineTranscriptSchema = z.object({
  audioChecksum: generationRecipeChecksumSchema,
  extraction: notebookLmExecutionEvidenceSchema,
  path: relativeArtifactPathSchema,
  providerArtifactId: z.string().trim().min(1),
  transcriptChecksum: generationRecipeChecksumSchema,
}).strict();

const baselineArtifactSchema = z.object({
  checksum: generationRecipeChecksumSchema,
  generation: notebookLmExecutionEvidenceSchema,
  mediaType: z.string().trim().min(1),
  path: relativeArtifactPathSchema,
  providerArtifactId: z.string().trim().min(1),
}).strict();

const baselineAudioArtifactSchema = baselineArtifactSchema.extend({
  transcript: baselineTranscriptSchema.optional(),
}).strict();

const baselineBriefAudioArtifactSchema = baselineAudioArtifactSchema.extend({
  path: z.literal('audio/notebooklm-short-brief.m4a'),
}).strict();

const baselineDiscussionAudioArtifactSchema = baselineAudioArtifactSchema.extend({
  path: z.literal('audio/notebooklm-medium-debate.m4a'),
}).strict();

export const nugletMediaBaselineSchema = z.object({
  descriptorChecksum: generationRecipeChecksumSchema,
  descriptorPath: z.literal('knowledge-bits/media-baseline.v1.json'),
  descriptor: z.object({
    artifacts: z.object({
      infographic: baselineArtifactSchema,
      audioBrief: baselineBriefAudioArtifactSchema,
      audioDiscussion: baselineDiscussionAudioArtifactSchema,
    }).strict(),
    notebookId: z.string().trim().min(1),
    runFolder: relativeArtifactPathSchema,
    runId: z.string().trim().min(1),
    schemaVersion: z.literal('nuglet.media-baseline.v1'),
  }).strict(),
}).strict();

const nugletGenerationRecipesSchema = z.object({
    story: generationRecipeBindingSchema('nuglet.lesson.story'),
    playbook: generationRecipeBindingSchema('nuglet.lesson.playbook'),
    challenge: generationRecipeBindingSchema('nuglet.challenge'),
    infographic: generationRecipeBindingSchema('nuglet.visual.infographic'),
    audioBrief: generationRecipeBindingSchema('nuglet.audio.brief'),
    audioDiscussion: generationRecipeBindingSchema('nuglet.audio.discussion'),
    hero: generationRecipeBindingSchema('nuglet.hero'),
    editorialQa: generationRecipeBindingSchema('nuglet.qa.editorial'),
  }).strict();

const nugletHeroDirectionSchema = z.object({
    concept: z.string().trim().min(1),
    metaphor: z.string().trim().min(1),
    compositionFamily: z.literal('asymmetrical-story'),
    mustInclude: z.array(z.string().trim().min(1)),
    mustAvoid: z.array(z.string().trim().min(1)),
  }).strict();

export const nugletGenerationPlanSchema = z.object({
  contentKind: z.literal('nuglet.lesson.v1'),
  schemaVersion: z.literal('1.1.0'),
  recipes: nugletGenerationRecipesSchema,
  heroDirection: nugletHeroDirectionSchema,
  mediaBaseline: nugletMediaBaselineSchema,
}).strict().superRefine((plan, context) => {
  const expected = [
    ['infographic', plan.recipes.infographic],
    ['audioBrief', plan.recipes.audioBrief],
    ['audioDiscussion', plan.recipes.audioDiscussion],
  ] as const;
  for (const [role, recipe] of expected) {
    const artifact = plan.mediaBaseline.descriptor.artifacts[role];
    validateBaselineEvidenceBinding(artifact.generation, artifact.providerArtifactId, recipe, plan.mediaBaseline.descriptor.notebookId, ['mediaBaseline', 'descriptor', 'artifacts', role, 'generation'], context);
    if ('transcript' in artifact && artifact.transcript) {
      if (artifact.transcript.audioChecksum !== artifact.checksum) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'transcript audio checksum must match artifact checksum', path: ['mediaBaseline', 'descriptor', 'artifacts', role, 'transcript', 'audioChecksum'] });
      }
      validateBaselineEvidenceBinding(artifact.transcript.extraction, artifact.transcript.providerArtifactId, recipe, plan.mediaBaseline.descriptor.notebookId, ['mediaBaseline', 'descriptor', 'artifacts', role, 'transcript', 'extraction'], context);
    }
  }
  const brief = plan.mediaBaseline.descriptor.artifacts.audioBrief;
  const discussion = plan.mediaBaseline.descriptor.artifacts.audioDiscussion;
  for (const field of ['path', 'providerArtifactId', 'checksum'] as const) {
    if (brief[field] === discussion[field]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Brief and Discussion ${field} must be distinct`,
        path: ['mediaBaseline', 'descriptor', 'artifacts', 'audioDiscussion', field],
      });
    }
  }
});

function validateBaselineEvidenceBinding(
  evidence: z.infer<typeof notebookLmExecutionEvidenceSchema>,
  artifactId: string,
  recipe: z.infer<typeof genericGenerationRecipeBindingSchema>,
  notebookId: string,
  path: (string | number)[],
  context: z.RefinementCtx,
): void {
  if (evidence.artifactId !== artifactId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'evidence artifact ID mismatch', path: [...path, 'artifactId'] });
  }
  if (evidence.notebookId !== notebookId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'evidence notebook ID mismatch', path: [...path, 'notebookId'] });
  }
  if (evidence.recipe.id !== recipe.id
    || evidence.recipe.version !== recipe.version
    || evidence.recipe.checksum !== recipe.checksum) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'evidence recipe binding mismatch', path: [...path, 'recipe'] });
  }
}

export type NugletMediaBaseline = z.infer<typeof nugletMediaBaselineSchema>;

export const knowledgeBitsRunBriefSchema = z.record(z.unknown()).superRefine((brief, context) => {
  const generationPlan = brief.generationPlan;
  if (!targetsNugletLesson(brief)) return;
  const parsed = nugletGenerationPlanSchema.safeParse(generationPlan);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({ ...issue, path: ['generationPlan', ...issue.path] });
    }
    return;
  }
  const baseline = isUnknownRecord(brief.baseline) ? brief.baseline : undefined;
  const baselineRunId = baseline?.runId;
  if (typeof baselineRunId !== 'string' || baselineRunId !== parsed.data.mediaBaseline.descriptor.runId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'media baseline run ID must match brief baseline run ID',
      path: ['baseline', 'runId'],
    });
  }
  if (typeof brief.notebookLmNotebookId !== 'string'
    || brief.notebookLmNotebookId !== parsed.data.mediaBaseline.descriptor.notebookId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'media baseline notebook ID must match brief NotebookLM notebook ID',
      path: ['notebookLmNotebookId'],
    });
  }
});

export const knowledgeBitsCreateRunRequestSchema = createRunRequestSchema.superRefine((request, context) => {
  const parsedBrief = knowledgeBitsRunBriefSchema.safeParse(request.brief);
  if (!parsedBrief.success) {
    for (const issue of parsedBrief.error.issues) {
      context.addIssue({ ...issue, path: ['brief', ...issue.path] });
    }
    return;
  }
  if (!targetsNugletLesson(parsedBrief.data) || request.notebookLmNotebookId === undefined) return;
  if (request.notebookLmNotebookId !== parsedBrief.data.notebookLmNotebookId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'request NotebookLM notebook ID must match brief NotebookLM notebook ID',
      path: ['notebookLmNotebookId'],
    });
  }
});

export const prepareLegacyRevisionRequestSchema = z.object({
  expectedRevision: z.number().int().positive(),
  expectedPackageChecksum: checksumSchema,
  notebookLmNotebookId: z.string().trim().min(1),
  brief: z.record(z.unknown()),
  comment: z.string().trim().min(1),
}).strict().superRefine((request, context) => {
  const parsedBrief = knowledgeBitsRunBriefSchema.safeParse(request.brief);
  if (!parsedBrief.success) {
    for (const issue of parsedBrief.error.issues) {
      context.addIssue({ ...issue, path: ['brief', ...issue.path] });
    }
    return;
  }
  const generationPlan = nugletGenerationPlanSchema.safeParse(parsedBrief.data.generationPlan);
  if (!generationPlan.success || generationPlan.data.contentKind !== 'nuglet.lesson.v1') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Legacy revision preparation requires a strict Nuglet generation plan',
      path: ['brief', 'generationPlan'],
    });
    return;
  }
  if (parsedBrief.data.notebookLmNotebookId !== request.notebookLmNotebookId
    || generationPlan.data.mediaBaseline.descriptor.notebookId !== request.notebookLmNotebookId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Replacement brief NotebookLM notebook ID must match the request',
      path: ['notebookLmNotebookId'],
    });
  }
});

export const prepareLegacyRevisionResponseSchema = z.object({
  run: workflowRunResponseSchema,
  previousRevision: z.number().int().positive(),
  previousPackageChecksum: checksumSchema,
}).strict();

function targetsNugletLesson(brief: Record<string, unknown>): boolean {
  const generationPlan = brief.generationPlan;
  return brief.contentKind === 'nuglet.lesson.v1'
    || (isUnknownRecord(generationPlan) && generationPlan.contentKind === 'nuglet.lesson.v1');
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

export function normalizeNugletTerminologyTerm(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export const storyPlaybookDraftContractDescriptor = {
  descriptorVersion: 'nuglet.lesson.story-playbook-draft.contract.v1',
  target: {
    kind: 'nuglet.lesson.v1',
    schemaVersion: '1.1.0',
  },
  outputEnvelope: {
    kind: 'nuglet.lesson.v1',
    schemaVersion: '1.1.0',
    payload: 'Story/Playbook draft payload object',
    noAlternateIntermediateShape: true,
  },
  exactConstraints: {
    payloadConstants: {
      contentModel: 'story-playbook.v1',
      materialization: 'draft',
    },
    claimIdentifiers: {
      claimId: 'UUID',
      claimReferences: 'UUID',
    },
    stringArrays: {
      'read.playbook.watchOuts': 'array of non-empty strings with at least one item',
      'visual.textEquivalent': 'array of non-empty strings with at least one item',
    },
    heroAccessibilityPurpose: ['informative', 'decorative'],
  },
  payloadShape: {
    contentModel: 'story-playbook.v1',
    materialization: 'draft',
    identity: ['locale', 'topic.label', 'topic.categoryId', 'tags', 'title', 'deck', 'slugSuggestion'],
    learning: ['centralIdea', 'whyItMatters', 'oneLineToKeep', 'terminology', 'action.label', 'action.instruction'],
    hero: ['altText', 'accessibilityPurpose', 'mediaBrief.concept', 'mediaBrief.metaphor', 'mediaBrief.compositionFamily'],
    read: {
      story: ['title', 'estimatedMinutes', 'blocks[].type', 'blocks[].text', 'blocks[].claimRefs'],
      playbook: [
        'title',
        'estimatedMinutes',
        'principle',
        'whyItMatters',
        'steps[].id',
        'steps[].title',
        'steps[].body',
        'steps[].claimRefs',
        'example.title',
        'example.body',
        'example.claimRefs',
        'watchOuts',
        'action',
      ],
    },
    visual: ['title', 'altText', 'textEquivalent', 'claimRefs', 'mediaBrief.objective', 'mediaBrief.structure'],
    listen: {
      brief: ['editorialBrief.objective', 'editorialBrief.tone', 'editorialBrief.keyPoints'],
      discussion: ['editorialBrief.objective', 'editorialBrief.tone', 'editorialBrief.keyPoints'],
    },
    quiz: [
      'questions[].id',
      'questions[].prompt',
      'questions[].options[].id',
      'questions[].options[].text',
      'questions[].correctOptionId',
      'questions[].rationale',
      'questions[].reviewConcept',
      'questions[].claimRefs',
    ],
    publicSources: ['evidenceSourceId', 'label', 'publisher'],
    claims: ['claimId', 'statement', 'citations[].sourceId', 'citations[].excerpt'],
    claimCoverage: ['path', 'claimIds'],
  },
  structure: {
    story: {
      blockTypes: ['opening', 'turning_point', 'evidence', 'practical_bridge'],
      requiredBlockTypes: ['opening', 'turning_point', 'evidence', 'practical_bridge'],
      evidenceBlocksRequireClaimRefs: true,
    },
    playbook: {
      stepCount: { min: 3, max: 5 },
      requiredFields: ['principle', 'whyItMatters', 'example', 'watchOuts', 'action'],
    },
    challenge: {
      questionCount: 3,
      optionsPerQuestion: { min: 3, max: 4 },
    },
    terminology: {
      minItems: 1,
      normalization: ['Unicode NFKC', 'locale-independent lowercase', 'non-letter-or-number runs to one space', 'trim'],
      requiredUsage: ['read.story', 'read.playbook'],
    },
  },
  claimCoveragePaths: storyPlaybookLearnerContentPathSchema.options,
  semanticBoundary: {
    materialization: 'draft',
    excludedOutput: ['artifact references', 'final media metadata', 'audio bytes', 'transcripts'],
  },
} as const;

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
  terminology: z.array(z.string().trim().min(1)).min(1),
  action: z.object({
    label: z.string().trim().min(1),
    instruction: z.string().trim().min(1),
  }).strict(),
}).strict().superRefine(({ terminology }, context) => {
  const normalized = terminology.map(normalizeNugletTerminologyTerm);
  if (normalized.some((term) => !term) || new Set(normalized).size !== normalized.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Canonical terminology must be non-empty and unique after normalization',
      path: ['terminology'],
    });
  }
});

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
    read: {
      story: z.infer<typeof storySchema>;
      playbook: z.infer<typeof playbookSchema>;
    };
    visual: z.infer<typeof visualBriefSchema>;
    quiz: { questions: z.infer<typeof quizQuestionSchema>[] };
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

  const nestedReferences = [
    ...value.read.story.blocks.flatMap((block, blockIndex) => block.claimRefs.map((claimId, claimIndex) => ({
      claimId,
      coveragePath: 'read.story' as const,
      issuePath: ['read', 'story', 'blocks', blockIndex, 'claimRefs', claimIndex],
    }))),
    ...value.read.playbook.steps.flatMap((step, stepIndex) => step.claimRefs.map((claimId, claimIndex) => ({
      claimId,
      coveragePath: 'read.playbook' as const,
      issuePath: ['read', 'playbook', 'steps', stepIndex, 'claimRefs', claimIndex],
    }))),
    ...value.read.playbook.example.claimRefs.map((claimId, claimIndex) => ({
      claimId,
      coveragePath: 'read.playbook' as const,
      issuePath: ['read', 'playbook', 'example', 'claimRefs', claimIndex],
    })),
    ...value.visual.claimRefs.map((claimId, claimIndex) => ({
      claimId,
      coveragePath: 'visual' as const,
      issuePath: ['visual', 'claimRefs', claimIndex],
    })),
    ...value.quiz.questions.flatMap((question, questionIndex) => question.claimRefs.map((claimId, claimIndex) => ({
      claimId,
      coveragePath: 'quiz' as const,
      issuePath: ['quiz', 'questions', questionIndex, 'claimRefs', claimIndex],
    }))),
  ];
  const coverageByPath = new Map(value.claimCoverage.map((entry) => [entry.path, new Set(entry.claimIds)]));

  nestedReferences.forEach(({ claimId, coveragePath, issuePath }) => {
    if (!claimIds.has(claimId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Nested claim reference must resolve to a declared claim',
        path: issuePath,
      });
      return;
    }

    if (!coverageByPath.get(coveragePath)?.has(claimId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Nested claim reference must appear in learner path coverage for ${coveragePath}`,
        path: issuePath,
      });
    }
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

export const storyPlaybookDraftTargetSchema = z.object({
  kind: z.literal('nuglet.lesson.v1'),
  schemaVersion: z.literal('1.1.0'),
  payload: storyPlaybookDraftSchema,
}).strict();

export const nugletGenerationInputSchema = z.object({
  schemaVersion: z.literal('knowledge-bits.generation-input.v1'),
  semanticTarget: storyPlaybookDraftTargetSchema,
  media: z.object({
    recipes: nugletGenerationRecipesSchema.pick({
      hero: true,
      infographic: true,
      audioBrief: true,
      audioDiscussion: true,
    }),
    heroDirection: nugletHeroDirectionSchema,
    mediaBaseline: nugletMediaBaselineSchema,
  }).strict(),
}).strict();

const pointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
}).strict();

const transcriptSchema = z.object({
  source: z.literal('final_audio_bytes'),
  text: z.string().trim().min(1),
  checksum: checksumSchema,
}).strict();

const imageMediaTypeSchema = z.string().regex(/^image\/.+$/);
const audioMediaTypeSchema = z.string().regex(/^audio\/.+$/);

const heroArtifactReferenceSchema = artifactReferenceSchema.extend({
  kind: z.literal('hero'),
  mediaType: imageMediaTypeSchema,
});

const infographicArtifactReferenceSchema = artifactReferenceSchema.extend({
  kind: z.literal('infographic'),
  mediaType: imageMediaTypeSchema,
});

function finalAudioSchema(kind: 'audio_brief' | 'audio_discussion') {
  return z.object({
    editorialBrief: audioEditorialBriefSchema.shape.editorialBrief,
    asset: artifactReferenceSchema.extend({
      kind: z.literal(kind),
      mediaType: audioMediaTypeSchema,
    }),
    durationSeconds: z.number().positive(),
    transcript: transcriptSchema,
  }).strict();
}

export const storyPlaybookPayloadSchema = z.object({
  ...storyPlaybookBaseShape,
  materialization: z.literal('materialized'),
  hero: z.object({
    ...heroBriefSchema.shape,
    asset: heroArtifactReferenceSchema,
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
    asset: infographicArtifactReferenceSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }).strict(),
  listen: z.object({
    brief: finalAudioSchema('audio_brief'),
    discussion: finalAudioSchema('audio_discussion'),
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
export type NugletGenerationPlan = z.infer<typeof nugletGenerationPlanSchema>;
export type NugletGenerationInput = z.infer<typeof nugletGenerationInputSchema>;
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

export const reviewAssetSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('missing'), artifactId: z.null(), mediaType: z.null(), previewPath: z.null() }).strict(),
  z.object({ state: z.literal('available'), artifactId: z.string().uuid(), mediaType: z.string().min(1), previewPath: z.string().min(1) }).strict(),
]);

export const reviewGenerationRoleSchema = z.enum([
  'story',
  'playbook',
  'quiz',
  'hero',
  'infographic',
  'audioBrief',
  'audioDiscussion',
]);

export const reviewGenerationExecutionSchema = z.object({
  role: reviewGenerationRoleSchema,
  recipe: genericGenerationRecipeBindingSchema,
  jobId: z.string().uuid(),
  executionId: z.string().trim().min(1),
  model: z.string().trim().min(1),
  outputKind: z.string().trim().min(1),
  outputChecksum: generationRecipeChecksumSchema,
  promptChecksum: generationRecipeChecksumSchema,
  referenceChecksums: z.array(generationRecipeChecksumSchema),
  recipeSnapshot: artifactReferenceSchema.extend({
    kind: z.literal('generation.recipe.snapshot'),
  }),
  renderedPrompt: artifactReferenceSchema.extend({
    kind: z.literal('generation.prompt.rendered'),
  }),
  executionReport: artifactReferenceSchema.extend({
    kind: z.literal('generation.execution.report'),
  }),
}).strict();

export const reviewGenerationExecutionsSchema = z.object({
  story: z.array(reviewGenerationExecutionSchema),
  playbook: z.array(reviewGenerationExecutionSchema),
  quiz: z.array(reviewGenerationExecutionSchema),
  hero: z.array(reviewGenerationExecutionSchema),
  infographic: z.array(reviewGenerationExecutionSchema),
  audioBrief: z.array(reviewGenerationExecutionSchema),
  audioDiscussion: z.array(reviewGenerationExecutionSchema),
}).strict().superRefine((executions, context) => {
  for (const role of reviewGenerationRoleSchema.options) {
    executions[role].forEach((execution, index) => {
      if (execution.role !== role) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Generation execution role must match its review summary key',
          path: [role, index, 'role'],
        });
      }
    });
  }
});

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
    audioBrief: reviewAssetSchema,
    audioDiscussion: reviewAssetSchema,
  }).strict(),
  generationExecutions: reviewGenerationExecutionsSchema,
}).strict();

export type ReviewAsset = z.infer<typeof reviewAssetSchema>;
export type ReviewGenerationRole = z.infer<typeof reviewGenerationRoleSchema>;
export type ReviewGenerationExecution = z.infer<typeof reviewGenerationExecutionSchema>;
export type ReviewGenerationExecutions = z.infer<typeof reviewGenerationExecutionsSchema>;
export type ReviewReadModel = z.infer<typeof reviewReadModelSchema>;
