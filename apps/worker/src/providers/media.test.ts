import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { NugletGenerationPlan } from '@knowledge-bits/contracts';
import { calculateContentChecksum } from '@knowledge-bits/pipeline';

import { MediaProviderAdapter, type MediaClient, type MediaKind } from './media.js';
import type { ProviderExecutionInput, ProviderSupportArtifact } from './types.js';
import { canonicalJsonBytes } from '../recipes/file-registry.js';
import type { ResolvedNugletRecipes, ResolvedRecipe } from '../recipes/types.js';

const otherChecksum = 'b'.repeat(64);
const requiredKinds = ['hero', 'infographic', 'audio_brief', 'audio_discussion'] as const;

test('media fails closed unless exactly one current-checksum asset exists for every required kind', async () => {
  const incomplete = providerFor((request) => request.kinds.slice(0, 3).map((kind) => generated(kind)));
  await assert.rejects(() => incomplete.execute(mediaInput()), /media_assets_incomplete/);

  const duplicate = providerFor(() => [
    generated('hero'),
    generated('infographic'),
    generated('audio_brief'),
    generated('audio_brief'),
    generated('audio_discussion'),
  ]);
  await assert.rejects(() => duplicate.execute(mediaInput()), /media_assets_incomplete/);

  const mismatch = providerFor(() => requiredKinds.map((kind) => generated(
    kind,
    kind === 'audio_discussion' ? otherChecksum : generationInputChecksum,
  )));
  await assert.rejects(() => mismatch.execute(mediaInput()), /media_input_checksum_mismatch/);
});

test('media passes four resolved recipe snapshots and per-run hero direction in one bounded request', async () => {
  const requests: Array<Parameters<MediaClient['generate']>[0]> = [];
  const provider = providerFor((request) => {
    requests.push(request);
    return request.kinds.map((kind) => generated(kind));
  });

  const result = await provider.execute(mediaInput());

  assert.equal(result.kind, 'success');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.kinds, requiredKinds);
  assert.equal(requests[0]?.generationInputChecksum, generationInputChecksum);
  assert.notEqual(requests[0]?.generationInputChecksum, semanticChecksum);
  assert.deepEqual(requests[0]?.heroDirection, generationPlan.heroDirection);
  assert.equal(requests[0]?.resolvedRecipes.hero.id, 'nuglet.hero');
  assert.equal(requests[0]?.resolvedRecipes.infographic.id, 'nuglet.visual.infographic');
  assert.equal(requests[0]?.resolvedRecipes.audioBrief.id, 'nuglet.audio.brief');
  assert.equal(requests[0]?.resolvedRecipes.audioDiscussion.id, 'nuglet.audio.discussion');
});

test('media preserves measured metadata and recipe support evidence on all four outputs', async () => {
  const provider = providerFor((request) => request.kinds.map((kind) => generated(kind)));

  const result = await provider.execute(mediaInput());

  assert.equal(result.kind, 'success');
  if (result.kind !== 'success') return;
  const parsed = result.parsedOutput as {
    assets: Array<{ kind: MediaKind; generationInputChecksum: string; metadata: Record<string, unknown> }>;
  };
  assert.deepEqual(parsed.assets.map(({ kind }) => kind), requiredKinds);
  assert.ok(parsed.assets.every((asset) => asset.generationInputChecksum === generationInputChecksum));
  assert.ok(parsed.assets.every((asset) => asset.metadata.byteSize === Buffer.from(asset.kind).byteLength));
  assert.equal(result.supportArtifacts?.length, 12);
  assert.deepEqual(
    result.assets?.map((asset) => ({ kind: asset.kind, provenance: asset.provenance })),
    requiredKinds.map((kind) => ({
      kind,
      provenance: {
        ...metadataFor(kind),
        generationExecutions: executionBindingsFor(kind),
      },
    })),
  );
  for (const artifact of result.supportArtifacts ?? []) {
    assert.match(String(artifact.provenance.outputChecksum), /^sha256:[a-f0-9]{64}$/);
    assert.ok(requiredKinds.includes(artifact.provenance.outputKind as typeof requiredKinds[number]));
  }
});

test('media invalidates stale outputs when generation directions change', async () => {
  const changedPlan = structuredClone(generationPlan);
  changedPlan.heroDirection.mustAvoid = [...changedPlan.heroDirection.mustAvoid, 'dense collage'];
  const requests: Array<Parameters<MediaClient['generate']>[0]> = [];
  const provider = providerFor((request) => {
    requests.push(request);
    return request.kinds.map((kind) => generated(kind, generationInputChecksum));
  }, changedPlan);

  await assert.rejects(() => provider.execute(mediaInput()), /media_input_checksum_mismatch/);
  assert.notEqual(requests[0]?.generationInputChecksum, generationInputChecksum);
});

test('media requires Task 6 hero crop metadata and approved profile checksum', async () => {
  for (const field of ['focalPoint', 'cropSafeArea', 'styleProfileChecksum'] as const) {
    const provider = providerFor((request) => request.kinds.map((kind) => {
      if (kind !== 'hero') return generated(kind);
      const metadata = { ...metadataFor(kind) };
      delete metadata[field];
      return { ...generated(kind), metadata };
    }));
    await assert.rejects(
      () => provider.execute(mediaInput()),
      field === 'styleProfileChecksum' ? /media_hero_profile_mismatch/ : /media_hero_metadata_invalid/,
    );
  }

  const mismatched = providerFor((request) => request.kinds.map((kind) => (
    kind === 'hero'
      ? { ...generated(kind), metadata: { ...metadataFor(kind), styleProfileChecksum: `sha256:${'f'.repeat(64)}` } }
      : generated(kind)
  )));
  await assert.rejects(() => mismatched.execute(mediaInput()), /media_hero_profile_mismatch/);
});

test('media rejects baseline bytes that do not match the immutable descriptor', async () => {
  const provider = providerFor((request) => request.kinds.map((kind) => (
    kind === 'infographic'
      ? { ...generated(kind), bytes: Buffer.from('wrong-baseline-bytes'), metadata: { ...metadataFor(kind), byteSize: 20 } }
      : generated(kind)
  )));

  await assert.rejects(() => provider.execute(mediaInput()), /media_baseline_checksum_mismatch/);
});

test('media rejects Brief and Discussion outputs with identical final bytes', async () => {
  const provider = providerFor((request) => request.kinds.map((kind) => {
    if (kind !== 'audio_discussion') return generated(kind);
    const bytes = Buffer.from('audio_brief');
    return {
      ...generated(kind),
      bytes,
      metadata: {
        ...metadataFor(kind),
        byteSize: bytes.byteLength,
        transcriptAudioChecksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      },
    };
  }));

  await assert.rejects(() => provider.execute(mediaInput()), /media_audio_roles_aliased/);
});

test('media accepts every complete provenance pair and rejects an incomplete additional execution', async () => {
  const complete = providerFor((request) => request.kinds.map((kind) => generated(kind)));
  const result = await complete.execute(mediaInput());
  assert.equal(result.kind, 'success');

  const incomplete = providerFor((request) => request.kinds.map((kind) => (
    kind === 'audio_discussion'
      ? { ...generated(kind), supportArtifacts: supportFor(kind).slice(0, 3) }
      : generated(kind)
  )));
  await assert.rejects(() => incomplete.execute(mediaInput()), /media_support_evidence_incomplete/);
});

function providerFor(
  generate: (request: Parameters<MediaClient['generate']>[0]) => unknown,
  plan: NugletGenerationPlan = generationPlan,
) {
  const client = {
    async generate(request: Parameters<MediaClient['generate']>[0]) {
      return generate(request);
    },
  } as unknown as MediaClient;
  return new MediaProviderAdapter({
    client,
    context: async () => ({
      passedCheck: true,
      content: candidate,
      contentChecksum: semanticChecksum,
      generationPlan: plan,
      resolvedRecipes,
    }),
  });
}

function generated(kind: MediaKind, inputChecksum = generationInputChecksum) {
  return {
    kind,
    mediaType: kind.startsWith('audio_') ? 'audio/mp4' : 'image/webp',
    bytes: Buffer.from(kind),
    generationInputChecksum: inputChecksum,
    metadata: metadataFor(kind),
    supportArtifacts: supportFor(kind),
  };
}

function metadataFor(kind: MediaKind): Record<string, unknown> {
  const byteSize = Buffer.from(kind).byteLength;
  return kind.startsWith('audio_')
    ? {
      byteSize,
      durationSeconds: kind === 'audio_brief' ? 91.25 : 287.5,
      transcript: `${kind} final transcript`,
      transcriptAudioChecksum: `sha256:${createHash('sha256').update(kind).digest('hex')}`,
      transcriptSource: kind === 'audio_brief' ? 'notebooklm' : 'vertex_gemini',
    }
    : kind === 'hero'
      ? {
        byteSize,
        width: 1024,
        height: 768,
        focalPoint: { x: 0.5, y: 0.5 },
        cropSafeArea: { x: 0.125, y: 0.125, width: 0.75, height: 0.75 },
        styleProfileChecksum: generationPlan.recipes.hero.checksum,
        referenceChecksums: heroReferenceChecksums,
      }
      : { byteSize, width: 1536, height: 2752 };
}

function executionBindingsFor(kind: MediaKind) {
  const outputChecksum = `sha256:${createHash('sha256').update(kind).digest('hex')}`;
  return supportFor(kind)
    .filter((artifact) => artifact.kind === 'generation.recipe.snapshot')
    .map((artifact) => ({
      ...artifact.provenance,
      outputKind: kind,
      outputChecksum,
    }));
}

function supportFor(kind: MediaKind): ProviderSupportArtifact[] {
  const recipe = recipeFor(kind);
  const pairs = [supportPair(kind, recipe, Buffer.from(`Generate ${kind}`), {
    artifactId: kind === 'hero' ? undefined : `${kind}-artifact`,
    model: kind === 'hero' ? 'vertex:fixture-image' : 'notebooklm-cli:fixture',
    notebookId: kind === 'hero' ? undefined : 'notebook-fixture',
    provider: kind === 'hero' ? 'vertex' : 'notebooklm',
  })];
  if (kind.startsWith('audio_')) {
    pairs.push(kind === 'audio_brief'
      ? supportPair(kind, recipe, Buffer.from(`Extract ${kind}`), {
        artifactId: `${kind}-transcript`,
        model: 'notebooklm-cli:fixture',
        notebookId: 'notebook-fixture',
        provider: 'notebooklm',
      })
      : supportPair(kind, recipe, Buffer.from(`Transcribe ${kind}`), {
        model: 'vertex:fixture-transcriber',
        provider: 'vertex',
      }));
  }
  return pairs.flat();
}

function supportPair(
  kind: MediaKind,
  recipe: ResolvedRecipe,
  prompt: Buffer,
  execution: { artifactId?: string; model: string; notebookId?: string; provider: string },
): ProviderSupportArtifact[] {
  const provenance = {
    ...execution,
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    recipeChecksum: recipe.checksum,
    promptChecksum: `sha256:${createHash('sha256').update(prompt).digest('hex')}`,
    referenceChecksums: kind === 'hero' ? heroReferenceChecksums : [],
  };
  return [{
    kind: 'generation.recipe.snapshot',
    mediaType: 'application/json',
    body: recipe.canonicalBytes,
    inputChecksum: null,
    provenance,
  }, {
    kind: 'generation.prompt.rendered',
    mediaType: 'text/plain',
    body: prompt,
    inputChecksum: recipe.checksum.replace(/^sha256:/, ''),
    provenance,
  }];
}

function recipeFor(kind: MediaKind): ResolvedRecipe {
  if (kind === 'hero') return resolvedRecipes.hero;
  if (kind === 'infographic') return resolvedRecipes.infographic;
  if (kind === 'audio_brief') return resolvedRecipes.audioBrief;
  return resolvedRecipes.audioDiscussion;
}

const heroReferenceChecksums = [`sha256:${'1'.repeat(64)}`, `sha256:${'2'.repeat(64)}`];
const generationPlan: NugletGenerationPlan = {
  contentKind: 'nuglet.lesson.v1',
  schemaVersion: '1.1.0',
  recipes: {
    story: binding('nuglet.lesson.story', '3'),
    playbook: binding('nuglet.lesson.playbook', '4'),
    challenge: binding('nuglet.challenge', '5'),
    infographic: binding('nuglet.visual.infographic', '6'),
    audioBrief: binding('nuglet.audio.brief', '7'),
    audioDiscussion: binding('nuglet.audio.discussion', '8'),
    hero: binding('nuglet.hero', '9'),
    editorialQa: binding('nuglet.qa.editorial', '0'),
  },
  heroDirection: {
    concept: 'Move from distraction to focus',
    metaphor: 'One stone settling beside a clear path',
    compositionFamily: 'asymmetrical-story',
    mustInclude: ['one focal object'],
    mustAvoid: ['rigid symmetry'],
  },
  mediaBaseline: {
    descriptorChecksum: `sha256:${'f'.repeat(64)}`,
    descriptorPath: 'knowledge-bits/media-baseline.v1.json',
    descriptor: {
      artifacts: {
        infographic: baselineArtifact('infographic', 'nuglet.visual.infographic', `sha256:${'6'.repeat(64)}`),
        audioBrief: {
          ...baselineArtifact('audio_brief', 'nuglet.audio.brief', `sha256:${'7'.repeat(64)}`),
          transcript: baselineTranscript('audio_brief', 'nuglet.audio.brief', `sha256:${'7'.repeat(64)}`),
        },
        audioDiscussion: baselineArtifact('audio_discussion', 'nuglet.audio.discussion', `sha256:${'8'.repeat(64)}`),
      },
      notebookId: 'notebook-fixture',
      runFolder: 'apps/nuglet-lab/outputs/fixture-run',
      runId: 'fixture-run',
      schemaVersion: 'nuglet.media-baseline.v1',
    },
  },
};

function baselineArtifact<Kind extends Exclude<MediaKind, 'hero'>>(
  kind: Kind,
  recipeId: string,
  recipeChecksum: string,
) {
  const prompt = Buffer.from(`Generate ${kind}`);
  return {
    checksum: `sha256:${createHash('sha256').update(kind).digest('hex')}`,
    generation: {
      artifactId: `${kind}-artifact`,
      model: 'notebooklm-cli:fixture',
      notebookId: 'notebook-fixture',
      prompt: {
        bytesBase64: prompt.toString('base64'),
        checksum: `sha256:${createHash('sha256').update(prompt).digest('hex')}`,
      },
      provider: 'notebooklm' as const,
      recipe: { id: recipeId, version: '1.0.0', checksum: recipeChecksum },
    },
    mediaType: kind.startsWith('audio_') ? 'audio/mp4' : 'image/webp',
    path: (kind === 'infographic'
      ? 'notebooklm/infographic.webp'
      : kind === 'audio_brief'
        ? 'audio/notebooklm-short-brief.m4a'
        : 'audio/notebooklm-medium-debate.m4a') as Kind extends 'audio_brief'
          ? 'audio/notebooklm-short-brief.m4a'
          : Kind extends 'audio_discussion'
            ? 'audio/notebooklm-medium-debate.m4a'
            : 'notebooklm/infographic.webp',
    providerArtifactId: `${kind}-artifact`,
  };
}

function baselineTranscript(kind: 'audio_brief', recipeId: string, recipeChecksum: string) {
  const prompt = Buffer.from(`Extract ${kind}`);
  const audioChecksum = `sha256:${createHash('sha256').update(kind).digest('hex')}`;
  return {
    audioChecksum,
    extraction: {
      artifactId: `${kind}-transcript`,
      model: 'notebooklm-cli:fixture',
      notebookId: 'notebook-fixture',
      prompt: {
        bytesBase64: prompt.toString('base64'),
        checksum: `sha256:${createHash('sha256').update(prompt).digest('hex')}`,
      },
      provider: 'notebooklm' as const,
      recipe: { id: recipeId, version: '1.0.0', checksum: recipeChecksum },
    },
    path: 'audio/audio_brief.transcript.json',
    providerArtifactId: `${kind}-transcript`,
    transcriptChecksum: `sha256:${'c'.repeat(64)}`,
  };
}

const resolvedRecipes = Object.fromEntries(Object.entries(generationPlan.recipes).map(([role, recipeBinding]) => {
  const value = recipeBinding.id === 'nuglet.hero'
    ? { ...recipeBinding, referenceAssets: heroReferenceChecksums.map((referenceChecksum) => ({ checksum: referenceChecksum })) }
    : recipeBinding;
  const canonicalBytes = canonicalJsonBytes(value);
  return [role, { ...recipeBinding, canonicalBytes, value }];
})) as unknown as ResolvedNugletRecipes;

function binding<Id extends NugletGenerationPlan['recipes'][keyof NugletGenerationPlan['recipes']]['id']>(id: Id, digit: string) {
  return { id, version: '1.0.0', checksum: `sha256:${digit.repeat(64)}` } as const;
}

const candidate = candidateFixture() as never;
const semanticChecksum = calculateContentChecksum(candidate);
const generationInputChecksum = calculateContentChecksum({
  schemaVersion: 'knowledge-bits.generation-input.v1',
  semanticTarget: candidate,
  media: {
    recipes: {
      hero: generationPlan.recipes.hero,
      infographic: generationPlan.recipes.infographic,
      audioBrief: generationPlan.recipes.audioBrief,
      audioDiscussion: generationPlan.recipes.audioDiscussion,
    },
    heroDirection: generationPlan.heroDirection,
    mediaBaseline: generationPlan.mediaBaseline,
  },
});

function candidateFixture() {
  const value = JSON.parse(readFileSync(
    new URL('./fixtures/notebooklm-story-playbook.json', import.meta.url),
    'utf8',
  )).answer;
  for (const claim of value.payload.claims) {
    claim.citations = claim.citations.map((citation: Record<string, unknown>) => ({
      ...citation,
      snapshotArtifactId: '11111111-1111-4111-8111-111111111111',
    }));
  }
  return value;
}

function mediaInput(): ProviderExecutionInput {
  return {
    action: 'produce_assets',
    idempotencyKey: 'operation_fixture',
    job: {
      jobId: '33333333-3333-4333-8333-333333333333',
      packageId: '44444444-4444-4444-8444-444444444444',
      stage: 'produce_assets',
      claimedBy: 'test-worker',
      claimedAt: '2026-07-13T10:00:00.000Z',
      leaseExpiresAt: '2026-07-13T10:02:00.000Z',
      executionDeadlineAt: '2026-07-13T10:05:00.000Z',
      attempt: 1,
      revision: 1,
      input: { brief: { generationPlan }, dependencies: [] },
    },
    signal: new AbortController().signal,
  };
}
