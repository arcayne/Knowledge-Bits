import assert from 'node:assert/strict';
import test from 'node:test';

import {
  nugletGenerationPlanSchema,
  type NugletGenerationPlan,
  type StoryPlaybookDraft,
} from '@knowledge-bits/contracts';
import { calculateContentChecksum } from '@knowledge-bits/pipeline';

import type { WorkflowArtifact } from '../repositories/workflow-repository.js';
import { materializeStoryPlaybookTarget } from './nuglet-package-materializer.js';

const sourceId = '11111111-1111-4111-8111-111111111111';
const snapshotArtifactId = '22222222-2222-4222-8222-222222222222';
const claimId = '33333333-3333-4333-8333-333333333331';
const secondClaimId = '33333333-3333-4333-8333-333333333332';

test('materializes the checked Story Playbook target with immutable media metadata and transcripts', () => {
  const semanticTarget = target();
  const generationPlan = plan();
  const generationInputChecksum = calculateContentChecksum(semanticTarget);
  const mediaArtifacts = assets(generationInputChecksum, generationPlan);

  const materialized = materializeStoryPlaybookTarget({
    semanticTarget,
    generationPlan,
    mediaArtifacts,
  });

  assert.equal(materialized.schemaVersion, '1.1.0');
  assert.equal(materialized.payload.materialization, 'materialized');
  assert.equal(materialized.payload.hero.asset.artifactId, mediaArtifacts.hero.id);
  assert.equal(materialized.payload.hero.width, 1200);
  assert.deepEqual(materialized.payload.hero.focalPoint, { x: 0.62, y: 0.44 });
  assert.equal(materialized.payload.visual.asset.artifactId, mediaArtifacts.infographic.id);
  assert.equal(materialized.payload.listen.brief.asset.artifactId, mediaArtifacts.audio_brief.id);
  assert.equal(materialized.payload.listen.brief.transcript.text, 'Brief final transcript.');
  assert.equal(materialized.payload.listen.discussion.asset.artifactId, mediaArtifacts.audio_discussion.id);
  assert.equal(materialized.payload.listen.discussion.transcript.text, 'Discussion final transcript.');
  assert.notEqual(
    materialized.payload.listen.brief.transcript.checksum,
    materialized.payload.listen.discussion.transcript.checksum,
  );
  assert.equal(materialized.payload.hero.asset.inputChecksum, generationInputChecksum);
});

test('rejects materialization when any required media role is missing', () => {
  const semanticTarget = target();
  const generationPlan = plan();
  const mediaArtifacts = assets(calculateContentChecksum(semanticTarget), generationPlan);
  const { audio_discussion: _missing, ...incomplete } = mediaArtifacts;

  assert.throws(() => materializeStoryPlaybookTarget({
    semanticTarget,
    generationPlan,
    mediaArtifacts: incomplete,
  }), /audio_discussion.*missing/i);
});

test('rejects stale generation input and invalid hero crop metadata', () => {
  const semanticTarget = target();
  const generationPlan = plan();
  const generationInputChecksum = calculateContentChecksum(semanticTarget);

  assert.throws(() => materializeStoryPlaybookTarget({
    semanticTarget,
    generationPlan,
    mediaArtifacts: assets('f'.repeat(64), generationPlan),
  }), /generation input checksum/i);

  const badCrop = assets(generationInputChecksum, generationPlan);
  delete badCrop.hero.provenance.cropSafeArea;
  assert.throws(() => materializeStoryPlaybookTarget({
    semanticTarget,
    generationPlan,
    mediaArtifacts: badCrop,
  }), /crop/i);
});

function target() {
  return {
    kind: 'nuglet.lesson.v1' as const,
    schemaVersion: '1.1.0' as const,
    payload: draft(),
  };
}

function draft(): StoryPlaybookDraft {
  const citations = [{ sourceId, snapshotArtifactId, excerpt: 'A small buffer can absorb an unexpected expense.' }];
  const claims = [
    { claimId, statement: 'A small buffer can absorb an unexpected expense.', citations },
    { claimId: secondClaimId, statement: 'Small repeatable transfers can build a buffer.', citations },
  ];
  return {
    materialization: 'draft',
    contentModel: 'story-playbook.v1',
    identity: {
      locale: 'en-GB',
      topic: { label: 'Personal finance', categoryId: null },
      tags: ['saving', 'resilience'],
      title: 'Build a rainy day fund',
      deck: 'Use a small repeatable transfer to prepare for surprise costs.',
      slugSuggestion: 'build-a-rainy-day-fund',
    },
    learning: {
      centralIdea: 'A small buffer reduces disruption from surprise costs.',
      whyItMatters: 'Money set aside makes an unexpected bill easier to absorb.',
      oneLineToKeep: 'Start with a buffer small enough to build consistently.',
      terminology: ['rainy day fund', 'reserve'],
      action: { label: 'Choose your first transfer', instruction: 'Set aside one affordable amount today.' },
    },
    hero: {
      altText: 'A vessel collecting coins beside a growing seedling.',
      accessibilityPurpose: 'informative',
      mediaBrief: {
        concept: 'Moving from surprise costs to resilience',
        metaphor: 'A vessel collecting tokens beside a seedling',
        compositionFamily: 'asymmetrical-story',
      },
    },
    read: {
      story: {
        title: 'The expense that arrived before payday',
        estimatedMinutes: 4,
        blocks: [
          { type: 'opening', text: 'The repair bill arrived on a Tuesday.', claimRefs: [] },
          { type: 'turning_point', text: 'A small reserve changed the decision.', claimRefs: [claimId] },
          { type: 'practical_bridge', text: 'The first transfer can be deliberately small.', claimRefs: [secondClaimId] },
        ],
      },
      playbook: {
        title: 'Build a buffer you can repeat',
        estimatedMinutes: 4,
        principle: 'Consistency matters more than a large first deposit.',
        whyItMatters: 'A repeatable transfer builds a reserve without destabilizing the month.',
        steps: [
          { id: 'step-1', title: 'Choose', body: 'Pick an affordable amount.', claimRefs: [secondClaimId] },
          { id: 'step-2', title: 'Separate', body: 'Move it to a dedicated place.', claimRefs: [claimId] },
          { id: 'step-3', title: 'Repeat', body: 'Schedule the next transfer.', claimRefs: [secondClaimId] },
        ],
        example: { title: 'Start with ten', body: 'Ten each week is a valid starting point.', claimRefs: [secondClaimId] },
        watchOuts: ['Do not choose an amount that creates a new shortfall.'],
        action: 'Set aside one affordable amount today.',
      },
    },
    visual: {
      title: 'The buffer loop',
      altText: 'A three-step loop showing choose, separate, and repeat.',
      textEquivalent: ['Choose an amount.', 'Separate the money.', 'Repeat the transfer.'],
      claimRefs: [claimId, secondClaimId],
      mediaBrief: { objective: 'Explain how a repeated transfer becomes a buffer.', structure: 'three-step loop' },
    },
    listen: {
      brief: { editorialBrief: { objective: 'Explain the central idea.', tone: 'calm and practical', keyPoints: ['Start small.', 'Repeat.'] } },
      discussion: { editorialBrief: { objective: 'Explore saving friction.', tone: 'reflective', keyPoints: ['Avoid shame.', 'Stay sustainable.'] } },
    },
    quiz: {
      questions: [
        question('q1', 'What is the central idea?', 'Start small', secondClaimId),
        question('q2', 'Which action is practical today?', 'Set aside an affordable amount', claimId),
        question('q3', 'What should you avoid?', 'An unaffordable transfer', claimId),
      ],
    },
    publicSources: [{ evidenceSourceId: sourceId, label: 'Example source', publisher: 'Example publisher' }],
    claims,
    claimCoverage: [
      { path: 'identity.title', claimIds: [claimId] },
      { path: 'learning.centralIdea', claimIds: [claimId] },
      { path: 'learning.whyItMatters', claimIds: [claimId] },
      { path: 'learning.oneLineToKeep', claimIds: [secondClaimId] },
      { path: 'learning.action', claimIds: [secondClaimId] },
      { path: 'read.story', claimIds: [claimId, secondClaimId] },
      { path: 'read.playbook', claimIds: [claimId, secondClaimId] },
      { path: 'visual', claimIds: [claimId, secondClaimId] },
      { path: 'listen.brief', claimIds: [claimId] },
      { path: 'listen.discussion', claimIds: [claimId, secondClaimId] },
      { path: 'quiz', claimIds: [claimId, secondClaimId] },
    ],
  };
}

function question(id: string, prompt: string, answer: string, claimRef: string) {
  return {
    id,
    prompt,
    options: [{ id: 'a', text: answer }, { id: 'b', text: 'Wait' }, { id: 'c', text: 'Borrow' }],
    correctOptionId: 'a',
    rationale: 'A repeatable small transfer is practical.',
    reviewConcept: 'Consistency and sustainability.',
    claimRefs: [claimRef],
  };
}

function plan(): NugletGenerationPlan {
  const recipe = (id: string, digit: string) => ({ id, version: '1.0.0', checksum: `sha256:${digit.repeat(64)}` });
  return nugletGenerationPlanSchema.parse({
    contentKind: 'nuglet.lesson.v1',
    schemaVersion: '1.1.0',
    recipes: {
      story: recipe('nuglet.lesson.story', '1'),
      playbook: recipe('nuglet.lesson.playbook', '2'),
      challenge: recipe('nuglet.challenge', '3'),
      infographic: recipe('nuglet.visual.infographic', '4'),
      audioBrief: recipe('nuglet.audio.brief', '5'),
      audioDiscussion: recipe('nuglet.audio.discussion', '6'),
      hero: recipe('nuglet.hero', '7'),
      editorialQa: recipe('nuglet.qa.editorial', '8'),
    },
    heroDirection: {
      concept: 'Moving from surprise costs to resilience',
      metaphor: 'A vessel collecting tokens beside a seedling',
      compositionFamily: 'asymmetrical-story',
      mustInclude: ['one vessel'],
      mustAvoid: ['rigid symmetry'],
    },
    mediaBaseline: mediaBaseline(),
  });
}

function mediaBaseline() {
  const evidence = (recipeId: string, artifactId: string, digit: string) => ({
    artifactId,
    model: 'notebooklm-cli:fixture',
    notebookId: 'notebook-fixture',
    prompt: { bytesBase64: Buffer.from(`Generate ${artifactId}`).toString('base64'), checksum: `sha256:${'a'.repeat(64)}` },
    provider: 'notebooklm',
    recipe: { id: recipeId, version: '1.0.0', checksum: `sha256:${digit.repeat(64)}` },
  });
  const artifact = (recipeId: string, artifactId: string, path: string, digit: string) => ({
    checksum: `sha256:${digit.repeat(64)}`,
    generation: evidence(recipeId, artifactId, digit === 'a' ? '4' : digit === 'b' ? '5' : '6'),
    mediaType: recipeId.includes('audio') ? 'audio/mp4' : 'image/webp',
    path,
    providerArtifactId: artifactId,
  });
  const infographic = artifact('nuglet.visual.infographic', 'infographic-artifact', 'notebooklm/infographic.webp', 'a');
  const audioBrief = artifact('nuglet.audio.brief', 'brief-artifact', 'audio/notebooklm-short-brief.m4a', 'b');
  const audioDiscussion = artifact('nuglet.audio.discussion', 'discussion-artifact', 'audio/notebooklm-medium-debate.m4a', 'c');
  return {
    descriptorChecksum: `sha256:${'d'.repeat(64)}`,
    descriptorPath: 'knowledge-bits/media-baseline.v1.json',
    descriptor: {
      artifacts: { infographic, audioBrief, audioDiscussion },
      notebookId: 'notebook-fixture',
      runFolder: 'apps/nuglet-lab/outputs/fixture-run',
      runId: 'fixture-run',
      schemaVersion: 'nuglet.media-baseline.v1',
    },
  };
}

function assets(generationInputChecksum: string, generationPlan: NugletGenerationPlan) {
  const artifact = (
    id: string,
    kind: string,
    mediaType: string,
    checksum: string,
    provenance: Record<string, unknown>,
  ): WorkflowArtifact => ({
    id,
    runId: '44444444-4444-4444-8444-444444444444',
    revision: 1,
    kind,
    mediaType,
    checksum,
    storageKey: `objects/${kind}`,
    byteSize: 256,
    provenance: { provider: 'fixture', byteSize: 256, ...provenance },
    inputChecksum: generationInputChecksum,
    jobId: '55555555-5555-4555-8555-555555555555',
    stage: 'produce_assets',
    action: 'produce_assets',
    createdAt: new Date('2026-07-15T10:00:00.000Z'),
  });
  return {
    hero: artifact('60000000-0000-4000-8000-000000000001', 'hero', 'image/webp', '1'.repeat(64), {
      width: 1200,
      height: 900,
      focalPoint: { x: 0.62, y: 0.44 },
      cropSafeArea: { x: 0.12, y: 0.1, width: 0.76, height: 0.8 },
      styleProfileChecksum: generationPlan.recipes.hero.checksum,
      referenceChecksums: [`sha256:${'9'.repeat(64)}`, `sha256:${'a'.repeat(64)}`],
      heroDirection: generationPlan.heroDirection,
    }),
    infographic: artifact('60000000-0000-4000-8000-000000000002', 'infographic', 'image/webp', '2'.repeat(64), {
      width: 1536,
      height: 2752,
    }),
    audio_brief: artifact('60000000-0000-4000-8000-000000000003', 'audio_brief', 'audio/mp4', '3'.repeat(64), {
      durationSeconds: 91.25,
      transcript: 'Brief final transcript.',
      transcriptAudioChecksum: `sha256:${'3'.repeat(64)}`,
      transcriptSource: 'notebooklm',
    }),
    audio_discussion: artifact('60000000-0000-4000-8000-000000000004', 'audio_discussion', 'audio/mp4', '4'.repeat(64), {
      durationSeconds: 287.5,
      transcript: 'Discussion final transcript.',
      transcriptAudioChecksum: `sha256:${'4'.repeat(64)}`,
      transcriptSource: 'vertex_gemini',
    }),
  };
}
