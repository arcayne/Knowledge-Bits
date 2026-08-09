import { nugletGenerationPlanSchema, type NugletGenerationPlan } from '@knowledge-bits/contracts';

type JsonObject = Record<string, unknown>;

const STANDARD_RECIPE_BINDINGS: NugletGenerationPlan['recipes'] = {
  story: {
    id: 'nuglet.lesson.story',
    version: '1.0.0',
    checksum: 'sha256:763e8a42ab8fc9fa23f098f11d9daa5b9042ee342bd92a7c1313a9b0714b220b',
  },
  playbook: {
    id: 'nuglet.lesson.playbook',
    version: '1.0.0',
    checksum: 'sha256:6c6342977dce5d473a0644215556f2f1b98f04985b2f945c8776078077334c4a',
  },
  challenge: {
    id: 'nuglet.challenge',
    version: '1.0.0',
    checksum: 'sha256:a520d1bef433a9cc263cc661b6e70f1c4bcf870f9985bfba9074f77ccf924713',
  },
  infographic: {
    id: 'nuglet.visual.infographic',
    version: '1.1.0',
    checksum: 'sha256:759dccde9da000a17644a3eb7a46a1e3cbeac76caaf7530b0676b19465b0e5b3',
  },
  audioBrief: {
    id: 'nuglet.audio.brief',
    version: '1.0.0',
    checksum: 'sha256:f6a9c3ae729cce5a9f29a4f28abdc6f9145050fdb54a4803995de9c775cde407',
  },
  audioDiscussion: {
    id: 'nuglet.audio.discussion',
    version: '1.0.0',
    checksum: 'sha256:ea43603f59f08552319c736727288b1acafe6466653605a2d278a9e207ee0e5c',
  },
  hero: {
    id: 'nuglet.hero',
    version: '1.0.0',
    checksum: 'sha256:c746be68da1739b51d3fee6278012fbfa3d5eb1890bc11cff9c6aa86174be571',
  },
  editorialQa: {
    id: 'nuglet.qa.editorial',
    version: '1.0.0',
    checksum: 'sha256:034bae01bae4a5cba84b3ed0e03239a50eb1bddfe28d9a40b5bb9dfd2bc61667',
  },
};

export function bindStandardNugletIntakePlan(input: {
  title: string;
  brief: JsonObject;
}): JsonObject {
  if (!isStandardStoryPlaybookIntake(input.brief) || input.brief.generationPlan !== undefined) {
    return input.brief;
  }
  const objective = stringValue(input.brief.objective) ?? input.title;
  const plan = nugletGenerationPlanSchema.parse({
    contentKind: 'nuglet.lesson.v1',
    schemaVersion: '1.1.0',
    recipes: STANDARD_RECIPE_BINDINGS,
    heroDirection: {
      concept: input.title,
      metaphor: `A clear bridge from the learner's current understanding to ${objective}`,
      compositionFamily: 'asymmetrical-story',
      mustInclude: [
        `one clear focal metaphor specific to ${input.title}`,
        'a visible transition from uncertainty to practical understanding',
      ],
      mustAvoid: [
        'generic icon grids',
        'text-heavy composition',
        'rigid symmetry',
        'literal corporate stock imagery',
      ],
    },
    heroMode: 'deferred',
    mediaMode: 'generate',
  });
  return {
    ...input.brief,
    contentKind: 'nuglet.lesson.v1',
    generationPlan: plan,
  };
}

export function standardRecipeBindings(): NugletGenerationPlan['recipes'] {
  return structuredClone(STANDARD_RECIPE_BINDINGS);
}

function isStandardStoryPlaybookIntake(brief: JsonObject): boolean {
  const intake = isRecord(brief.intake) ? brief.intake : undefined;
  return intake?.requestedFormat === 'story_playbook';
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
