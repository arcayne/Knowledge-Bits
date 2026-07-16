import { createHash } from 'node:crypto';

export const FIXTURE_NOTEBOOK_ID = 'notebook-schema-1-1-fixture';
export const FIXTURE_BASELINE_RUN_ID = 'schema-1-1-baseline-run';

export const RECIPE_IDS = {
  story: 'nuglet.lesson.story',
  playbook: 'nuglet.lesson.playbook',
  challenge: 'nuglet.challenge',
  infographic: 'nuglet.visual.infographic',
  audioBrief: 'nuglet.audio.brief',
  audioDiscussion: 'nuglet.audio.discussion',
  hero: 'nuglet.hero',
  editorialQa: 'nuglet.qa.editorial',
};

export const MEDIA_BYTES = {
  hero: Buffer.from('schema-1.1-hero-fixture'),
  infographic: Buffer.from('schema-1.1-infographic-fixture'),
  audio_brief: Buffer.from('schema-1.1-brief-audio-fixture'),
  audio_discussion: Buffer.from('schema-1.1-discussion-audio-fixture'),
};

export const HERO_REFERENCE_CHECKSUMS = [
  prefixedChecksum(Buffer.from('schema-1.1-hero-reference-primary')),
  prefixedChecksum(Buffer.from('schema-1.1-hero-reference-secondary')),
];

export function recipeSnapshotBody(role) {
  return Buffer.from(JSON.stringify({ id: RECIPE_IDS[role], version: '1.0.0' }));
}

export function renderedPrompt(role) {
  return Buffer.from(`Render the schema 1.1.0 ${role} fixture.`);
}

export function recipeBinding(role) {
  return {
    id: RECIPE_IDS[role],
    version: '1.0.0',
    checksum: prefixedChecksum(recipeSnapshotBody(role)),
  };
}

export function createSchema11RunRequest() {
  const recipes = Object.fromEntries(Object.keys(RECIPE_IDS).map((role) => [role, recipeBinding(role)]));
  const baselineArtifact = (role, kind, path) => {
    const providerArtifactId = `schema-1-1-${kind}`;
    return {
      checksum: prefixedChecksum(MEDIA_BYTES[kind]),
      generation: {
        artifactId: providerArtifactId,
        model: `notebooklm-fixture-${role}`,
        notebookId: FIXTURE_NOTEBOOK_ID,
        prompt: {
          bytesBase64: renderedPrompt(role).toString('base64'),
          checksum: prefixedChecksum(renderedPrompt(role)),
        },
        provider: 'notebooklm',
        recipe: recipes[role],
      },
      mediaType: kind.startsWith('audio_') ? 'audio/mp4' : 'image/webp',
      path,
      providerArtifactId,
    };
  };
  const descriptor = {
    artifacts: {
      infographic: baselineArtifact('infographic', 'infographic', 'notebooklm/infographic.webp'),
      audioBrief: baselineArtifact('audioBrief', 'audio_brief', 'audio/notebooklm-short-brief.m4a'),
      audioDiscussion: baselineArtifact('audioDiscussion', 'audio_discussion', 'audio/notebooklm-medium-debate.m4a'),
    },
    notebookId: FIXTURE_NOTEBOOK_ID,
    runFolder: 'apps/nuglet-lab/outputs/schema-1-1-baseline-run',
    runId: FIXTURE_BASELINE_RUN_ID,
    schemaVersion: 'nuglet.media-baseline.v1',
  };
  return {
    title: 'Schema 1.1.0 fixture proof',
    locale: 'en',
    notebookLmNotebookId: FIXTURE_NOTEBOOK_ID,
    brief: {
      audience: 'Adults rebuilding a focused work habit',
      baseline: { runId: FIXTURE_BASELINE_RUN_ID },
      contentKind: 'nuglet.lesson.v1',
      notebookLmNotebookId: FIXTURE_NOTEBOOK_ID,
      objective: 'Use a visible next step to reduce restart friction',
      topic: 'Attention Span Recovery',
      generationPlan: {
        contentKind: 'nuglet.lesson.v1',
        schemaVersion: '1.1.0',
        recipes,
        heroDirection: {
          concept: 'Returning to focused work',
          metaphor: 'One marked step on an unfinished path',
          compositionFamily: 'asymmetrical-story',
          mustInclude: ['one clear restart marker'],
          mustAvoid: ['rigid symmetry'],
        },
        mediaBaseline: {
          descriptorChecksum: prefixedChecksum(Buffer.from(JSON.stringify(descriptor))),
          descriptorPath: 'knowledge-bits/media-baseline.v1.json',
          descriptor,
        },
      },
    },
  };
}

export function prefixedChecksum(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
