import {
  nugletGenerationPlanSchema,
  nugletNarrativeGenerationPlanSchema,
  type NugletGenerationPlan,
  type NugletNarrativeGenerationPlan,
} from '@knowledge-bits/contracts';

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
    version: '2.0.0',
    checksum: 'sha256:f48e77547bf0d1b1890bc4118902fbcae185d6b55ec21c929410adab02677206',
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

const STANDARD_NARRATIVE_RECIPE_BINDINGS: NugletNarrativeGenerationPlan['recipes'] = {
  writer: {
    id: 'nuglet.lesson.narrative',
    version: '1.0.0',
    checksum: 'sha256:5ba879ed08334be93f573fe56e5ae106b6d3a489080a44609797db1bfbf56bb0',
  },
  challenge: {
    id: 'nuglet.challenge',
    version: '1.0.0',
    checksum: 'sha256:7aa0cab4452a6768187f3286ad3e1ccb01becfdca3bca69887fac1d9d7610686',
  },
  infographic: {
    id: 'nuglet.visual.infographic',
    version: '1.0.0',
    checksum: 'sha256:f24346b4dfafaf3892d4cc0c4f682bafa01acbd94487790ebb2d3ab0903fd03b',
  },
  audioConversation: {
    id: 'nuglet.audio.conversation',
    version: '1.0.0',
    checksum: 'sha256:89391ab0fd7232b74f2ecaa1367e54f8017c636714befc3e3a51425aa36c0dec',
  },
  hero: {
    id: 'nuglet.hero',
    version: '1.0.0',
    checksum: 'sha256:2f8a9a3b49afbae42fb6c8982c73c7002d71ea742dc36b3ac35c319f84bc89a1',
  },
  editorialQa: {
    id: 'nuglet.qa.editorial',
    version: '1.0.0',
    checksum: 'sha256:b01059444709225d061518b426511e5a7291d291dce4a864b3b83ea219968e00',
  },
};

export function bindStandardNugletIntakePlan(input: {
  title: string;
  brief: JsonObject;
}): JsonObject {
  if (input.brief.generationPlan !== undefined) {
    return input.brief;
  }
  if (isStandardNarrativeIntake(input.brief)) {
    const plan = nugletNarrativeGenerationPlanSchema.parse({
      contentKind: 'nuglet.lesson.v2',
      schemaVersion: '2.0.0',
      recipes: STANDARD_NARRATIVE_RECIPE_BINDINGS,
      heroDirection: standardHeroDirection(input.title),
      mediaMode: 'generate',
    });
    return {
      ...input.brief,
      contentKind: 'nuglet.lesson.v2',
      generationPlan: plan,
    };
  }
  if (!isStandardStoryPlaybookIntake(input.brief)) return input.brief;

  const plan = nugletGenerationPlanSchema.parse({
    contentKind: 'nuglet.lesson.v1',
    schemaVersion: '1.1.0',
    recipes: STANDARD_RECIPE_BINDINGS,
    heroDirection: standardHeroDirection(input.title),
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

export function standardNarrativeRecipeBindings(): NugletNarrativeGenerationPlan['recipes'] {
  return structuredClone(STANDARD_NARRATIVE_RECIPE_BINDINGS);
}

function standardHeroDirection(title: string) {
  return {
    concept: title,
    metaphor: `One physical action that makes ${title} immediately understandable`,
    compositionFamily: 'asymmetrical-story' as const,
    mustInclude: [
      `one clear focal metaphor specific to ${title}`,
      'the final checked lesson hero brief when content generation provides one',
    ],
    mustAvoid: [
      'generic icon grids',
      'text-heavy composition',
      'rigid symmetry',
      'literal corporate stock imagery',
    ],
  };
}

function isStandardStoryPlaybookIntake(brief: JsonObject): boolean {
  const intake = isRecord(brief.intake) ? brief.intake : undefined;
  return intake?.requestedFormat === 'story_playbook';
}

function isStandardNarrativeIntake(brief: JsonObject): boolean {
  const intake = isRecord(brief.intake) ? brief.intake : undefined;
  return intake?.requestedFormat === 'single_narrative';
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
