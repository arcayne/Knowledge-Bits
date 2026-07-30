import { z } from 'zod';

import { artifactReferenceSchema, checksumSchema } from './workflow.js';

const recipeVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const recipeChecksumSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

function recipeBindingSchema(id: string) {
  return z.object({
    id: z.literal(id),
    version: recipeVersionSchema,
    checksum: recipeChecksumSchema,
  }).strict();
}

export const nugletNarrativeGenerationPlanSchema = z.object({
  contentKind: z.literal('nuglet.lesson.v2'),
  schemaVersion: z.literal('2.0.0'),
  recipes: z.object({
    writer: recipeBindingSchema('nuglet.lesson.narrative'),
    challenge: recipeBindingSchema('nuglet.challenge'),
    infographic: recipeBindingSchema('nuglet.visual.infographic'),
    audioConversation: recipeBindingSchema('nuglet.audio.conversation'),
    hero: recipeBindingSchema('nuglet.hero'),
    editorialQa: recipeBindingSchema('nuglet.qa.editorial'),
  }).strict(),
  heroDirection: z.object({
    concept: z.string().trim().min(1),
    metaphor: z.string().trim().min(1),
    compositionFamily: z.literal('asymmetrical-story'),
    mustInclude: z.array(z.string().trim().min(1)),
    mustAvoid: z.array(z.string().trim().min(1)),
  }).strict(),
  mediaMode: z.literal('generate'),
}).strict();

const claimReferenceSchema = z.array(z.string().uuid());

const claimSchema = z.object({
  claimId: z.string().uuid(),
  statement: z.string().trim().min(1),
  citations: z.array(z.object({
    sourceId: z.string().trim().min(1),
    snapshotArtifactId: z.string().trim().min(1),
    excerpt: z.string().trim().min(1),
  }).strict()).min(1),
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
  oneLineToKeep: z.string().trim().min(1),
  action: z.object({
    label: z.string().trim().min(1),
    instruction: z.string().trim().min(1),
  }).strict(),
  terminology: z.array(z.object({
    term: z.string().trim().min(1),
    plainLanguage: z.string().trim().min(1),
  }).strict()).max(4),
}).strict();

const narrativeSectionSchema = z.object({
  id: z.string().trim().min(1),
  type: z.enum(['scene', 'discovery', 'evidence', 'application', 'close']),
  text: z.string().trim().min(1),
  claimRefs: claimReferenceSchema,
}).strict();

const lessonSchema = z.object({
  title: z.string().trim().min(1),
  estimatedMinutes: z.number().int().min(3).max(8),
  sections: z.array(narrativeSectionSchema).min(4).max(8),
}).strict().superRefine(({ sections }, context) => {
  const ids = new Set(sections.map(({ id }) => id));
  if (ids.size !== sections.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Narrative section IDs must be unique',
      path: ['sections'],
    });
  }
  const types = new Set(sections.map(({ type }) => type));
  for (const required of ['scene', 'discovery', 'evidence', 'application', 'close'] as const) {
    if (!types.has(required)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `The canonical lesson requires a ${required} section`,
        path: ['sections'],
      });
    }
  }
  const evidenceSections = sections.filter(({ type }) => type === 'evidence');
  if (evidenceSections.some(({ claimRefs }) => claimRefs.length === 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Evidence sections require claim references',
      path: ['sections'],
    });
  }
  const publicReadGroups = [
    sections.filter(({ type }) => type === 'scene' || type === 'discovery'),
    sections.filter(({ type }) => type === 'evidence'),
    sections.filter(({ type }) => type === 'application' || type === 'close'),
  ];
  if (publicReadGroups.some((group) => (
    group.map(({ text }) => text).join('\n\n').length > 1600
  ))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Narrative groups must fit the Nuglet public reading surface without truncation',
      path: ['sections'],
    });
  }
});

const quizQuestionSchema = z.object({
  id: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  options: z.array(z.object({
    id: z.string().trim().min(1),
    text: z.string().trim().min(1),
  }).strict()).min(3).max(4),
  correctOptionId: z.string().trim().min(1),
  rationale: z.string().trim().min(1),
  claimRefs: claimReferenceSchema,
}).strict().superRefine(({ correctOptionId, options }, context) => {
  const optionIds = new Set(options.map(({ id }) => id));
  if (optionIds.size !== options.length || !optionIds.has(correctOptionId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Quiz options must be unique and include the correct option',
      path: ['correctOptionId'],
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
  claimRefs: claimReferenceSchema,
  mediaBrief: z.object({
    objective: z.string().trim().min(1),
    structure: z.string().trim().min(1),
  }).strict(),
}).strict();

const conversationBriefSchema = z.object({
  editorialBrief: z.object({
    objective: z.string().trim().min(1),
    tone: z.string().trim().min(1),
    keyPoints: z.array(z.string().trim().min(1)).min(1),
    format: z.literal('two-person-conversation'),
  }).strict(),
}).strict();

export const nugletNarrativeClaimCoveragePathSchema = z.enum([
  'identity.title',
  'identity.deck',
  'learning.oneLineToKeep',
  'learning.action',
  'read.lesson',
  'visual',
  'listen.conversation',
  'quiz',
]);

const claimCoverageSchema = z.array(z.object({
  path: nugletNarrativeClaimCoveragePathSchema,
  claimIds: z.array(z.string().uuid()).min(1),
}).strict());

const publicSourceSchema = z.object({
  evidenceSourceId: z.string().trim().min(1),
  label: z.string().trim().min(1),
  publisher: z.string().trim().min(1),
}).strict();

const narrativeBaseShape = {
  // Keeps legacy consumers that still inspect payload.title type-safe while
  // the canonical V2 title remains identity.title.
  title: z.never().optional(),
  contentModel: z.literal('single-narrative.v2'),
  identity: identitySchema,
  learning: learningSchema,
  read: z.object({ lesson: lessonSchema }).strict(),
  quiz: z.object({ questions: z.array(quizQuestionSchema).length(3) }).strict(),
  publicSources: z.array(publicSourceSchema).min(1),
  claims: z.array(claimSchema).min(1),
  claimCoverage: claimCoverageSchema,
};

function validateNarrativeClaims(
  value: {
    claims: z.infer<typeof claimSchema>[];
    claimCoverage: z.infer<typeof claimCoverageSchema>;
    read: { lesson: z.infer<typeof lessonSchema> };
    visual: z.infer<typeof visualBriefSchema>;
    quiz: { questions: z.infer<typeof quizQuestionSchema>[] };
  },
  context: z.RefinementCtx,
): void {
  const claimIds = new Set(value.claims.map(({ claimId }) => claimId));
  const coverageByPath = new Map(value.claimCoverage.map(({ path, claimIds: ids }) => [path, new Set(ids)]));
  if (coverageByPath.size !== value.claimCoverage.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Claim coverage paths must be unique',
      path: ['claimCoverage'],
    });
  }

  value.claimCoverage.forEach((coverage, coverageIndex) => {
    coverage.claimIds.forEach((claimId, claimIndex) => {
      if (!claimIds.has(claimId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Claim coverage must reference a declared claim',
          path: ['claimCoverage', coverageIndex, 'claimIds', claimIndex],
        });
      }
    });
  });

  const nestedReferences = [
    ...value.read.lesson.sections.flatMap((section, sectionIndex) => section.claimRefs.map((claimId, claimIndex) => ({
      claimId,
      coveragePath: 'read.lesson' as const,
      issuePath: ['read', 'lesson', 'sections', sectionIndex, 'claimRefs', claimIndex],
    }))),
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

  nestedReferences.forEach(({ claimId, coveragePath, issuePath }) => {
    if (!claimIds.has(claimId) || !coverageByPath.get(coveragePath)?.has(claimId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Nested claim reference requires coverage for ${coveragePath}`,
        path: issuePath,
      });
    }
  });
}

export const nugletNarrativeDraftSchema = z.object({
  ...narrativeBaseShape,
  materialization: z.literal('draft'),
  hero: heroBriefSchema,
  visual: visualBriefSchema,
  listen: z.object({
    conversation: conversationBriefSchema,
  }).strict(),
}).strict().superRefine(validateNarrativeClaims);

const pointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
}).strict();

const transcriptSchema = z.object({
  source: z.literal('final_audio_bytes'),
  text: z.string().trim().min(1),
  checksum: checksumSchema,
}).strict();

export const nugletNarrativePayloadSchema = z.object({
  ...narrativeBaseShape,
  materialization: z.literal('materialized'),
  hero: z.object({
    ...heroBriefSchema.shape,
    asset: artifactReferenceSchema.extend({
      kind: z.literal('hero'),
      mediaType: z.string().regex(/^image\/.+$/),
    }),
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
    asset: artifactReferenceSchema.extend({
      kind: z.literal('infographic'),
      mediaType: z.string().regex(/^image\/.+$/),
    }),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }).strict(),
  listen: z.object({
    conversation: z.object({
      ...conversationBriefSchema.shape,
      asset: artifactReferenceSchema.extend({
        kind: z.literal('audio_conversation'),
        mediaType: z.string().regex(/^audio\/.+$/),
      }),
      durationSeconds: z.number().positive(),
      transcript: transcriptSchema,
    }).strict(),
  }).strict(),
}).strict().superRefine(validateNarrativeClaims);

export const nugletNarrativeDraftTargetSchema = z.object({
  kind: z.literal('nuglet.lesson.v2'),
  schemaVersion: z.literal('2.0.0'),
  payload: nugletNarrativeDraftSchema,
}).strict();

export const nugletNarrativeGenerationInputSchema = z.object({
  schemaVersion: z.literal('knowledge-bits.narrative-generation-input.v2'),
  semanticTarget: nugletNarrativeDraftTargetSchema,
  media: z.object({
    recipes: nugletNarrativeGenerationPlanSchema.shape.recipes.pick({
      hero: true,
      infographic: true,
      audioConversation: true,
    }),
    heroDirection: nugletNarrativeGenerationPlanSchema.shape.heroDirection,
  }).strict(),
}).strict();

export const nugletNarrativeTargetSchema = z.object({
  kind: z.literal('nuglet.lesson.v2'),
  schemaVersion: z.literal('2.0.0'),
  payload: z.union([nugletNarrativeDraftSchema, nugletNarrativePayloadSchema]),
}).strict();

export const nugletNarrativeDraftContractDescriptor = {
  descriptorVersion: 'nuglet.lesson.single-narrative-draft.contract.v2',
  target: { kind: 'nuglet.lesson.v2', schemaVersion: '2.0.0' },
  outputEnvelope: {
    kind: 'nuglet.lesson.v2',
    schemaVersion: '2.0.0',
    payload: 'Single narrative draft payload object',
  },
  productRule: {
    writtenLessonCount: 1,
    writtenLessonPath: 'payload.read.lesson',
    audioCount: 1,
    audioPath: 'payload.listen.conversation',
    forbiddenParallelFormats: ['playbook', 'brief audio', 'summary article'],
  },
  narrativeArc: ['scene', 'discovery', 'evidence', 'application', 'close'],
  voice: [
    'Write for an intelligent general reader, not a specialist.',
    'Introduce people and ideas in plain language before naming a theory or technical term.',
    'Prefer a scene, tension, discovery, and useful shift over a sequence of facts.',
    'Explain unavoidable terminology immediately in everyday language.',
  ],
  grounding: {
    acceptedSourcesOnly: true,
    unsupportedClaims: 'omit',
    claimIdentifiers: 'UUID',
    citationsRequireExactExcerpt: true,
  },
} as const;

export type NugletNarrativeGenerationPlan = z.infer<typeof nugletNarrativeGenerationPlanSchema>;
export type NugletNarrativeDraft = z.infer<typeof nugletNarrativeDraftSchema>;
export type NugletNarrativePayload = z.infer<typeof nugletNarrativePayloadSchema>;
export type NugletNarrativeTarget = z.infer<typeof nugletNarrativeTargetSchema>;
export type NugletNarrativeGenerationInput = z.infer<typeof nugletNarrativeGenerationInputSchema>;
