import assert from 'node:assert/strict';
import test from 'node:test';
import * as contracts from '../dist/index.js';
import {
  knowledgeBitsContentSchema,
  knowledgeBitsEvidenceSchema,
  knowledgeBitsQaSchema,
  knowledgeBitsSchema,
  knowledgeBitsCreateRunRequestSchema,
  prepareLegacyRevisionRequestSchema,
  prepareLegacyRevisionResponseSchema,
  knowledgeBitsRunBriefSchema,
  nugletGenerationPlanSchema,
  storyPlaybookDraftSchema,
  storyPlaybookDraftContractDescriptor,
  storyPlaybookPayloadSchema,
  jobClaimSchema,
  jobResultSchema,
  reviewRunRequestSchema,
  reviewReadModelSchema,
  stageStateSchema,
  workflowStageSchema,
} from '../dist/index.js';

const checksum = 'a'.repeat(64);
const packageId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const sourceId = '0f8fad5b-d9cb-469f-a165-70867728950f';
const claimId = '0f8fad5b-d9cb-469f-a165-708677289510';
const snapshotArtifactId = '0f8fad5b-d9cb-469f-a165-708677289512';

const recipeIds = {
  story: 'nuglet.lesson.story',
  playbook: 'nuglet.lesson.playbook',
  challenge: 'nuglet.challenge',
  infographic: 'nuglet.visual.infographic',
  audioBrief: 'nuglet.audio.brief',
  audioDiscussion: 'nuglet.audio.discussion',
  hero: 'nuglet.hero',
  editorialQa: 'nuglet.qa.editorial',
};

test('Story and Playbook descriptor states the exact provider output contract', () => {
  const descriptor = storyPlaybookDraftContractDescriptor;

  assert.deepEqual(descriptor.outputEnvelope, {
    kind: 'nuglet.lesson.v1',
    schemaVersion: '1.1.0',
    payload: 'Story/Playbook draft payload object',
    noAlternateIntermediateShape: true,
  });
  assert.deepEqual(descriptor.exactConstraints, {
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
  });
  assert.doesNotThrow(() => JSON.stringify(descriptor));
  assert.equal(JSON.stringify(descriptor), JSON.stringify(descriptor));
});

function validGenerationPlan() {
  return {
    contentKind: 'nuglet.lesson.v1',
    schemaVersion: '1.1.0',
    recipes: Object.fromEntries(Object.entries(recipeIds).map(([role, id]) => [role, {
      id,
      version: '1.0.0',
      checksum: `sha256:${checksum}`,
    }])),
    heroDirection: {
      concept: 'Moving from saving to growth',
      metaphor: 'A vessel connected to tokens and a seedling',
      compositionFamily: 'asymmetrical-story',
      mustInclude: ['one vessel'],
      mustAvoid: ['rigid symmetry'],
    },
    mediaBaseline: validMediaBaseline(),
  };
}

function validMediaBaseline() {
  const evidence = (recipeId, artifactId, prompt) => ({
    artifactId,
    model: 'notebooklm-cli:fixture',
    notebookId: 'notebook-fixture',
    prompt: {
      bytesBase64: Buffer.from(prompt).toString('base64'),
      checksum: `sha256:${checksum}`,
    },
    provider: 'notebooklm',
    recipe: { id: recipeId, version: '1.0.0', checksum: `sha256:${checksum}` },
  });
  const artifact = (recipeId, artifactId, path) => ({
    checksum: `sha256:${(
      artifactId === 'brief-artifact' ? 'b' : artifactId === 'discussion-artifact' ? 'c' : 'a'
    ).repeat(64)}`,
    generation: evidence(recipeId, artifactId, `Generate ${artifactId}`),
    mediaType: recipeId.includes('audio') ? 'audio/mp4' : 'image/webp',
    path,
    providerArtifactId: artifactId,
  });
  return {
    descriptorChecksum: `sha256:${checksum}`,
    descriptorPath: 'knowledge-bits/media-baseline.v1.json',
    descriptor: {
      artifacts: {
        infographic: artifact('nuglet.visual.infographic', 'infographic-artifact', 'notebooklm/infographic.webp'),
        audioBrief: artifact('nuglet.audio.brief', 'brief-artifact', 'audio/notebooklm-short-brief.m4a'),
        audioDiscussion: artifact('nuglet.audio.discussion', 'discussion-artifact', 'audio/notebooklm-medium-debate.m4a'),
      },
      notebookId: 'notebook-fixture',
      runFolder: 'apps/nuglet-lab/outputs/fixture-run',
      runId: 'fixture-run',
      schemaVersion: 'nuglet.media-baseline.v1',
    },
  };
}

function artifactReference(kind) {
  return {
    artifactId: '0f8fad5b-d9cb-469f-a165-708677289511',
    kind,
    mediaType: 'application/json',
    checksum,
    storageKey: `packages/${kind}.json`,
    byteSize: 128,
    createdAt: '2026-07-12T12:00:00.000Z',
    provider: 'fixture',
    inputChecksum: null,
  };
}

function validKnowledgeBits() {
  const citation = {
    sourceId,
    snapshotArtifactId,
    excerpt: 'An emergency fund covers unexpected expenses.',
  };
  const claims = [{
    claimId,
    statement: 'A rainy day fund can help cover an unexpected expense.',
    citations: [citation],
  }];
  return {
    schemaVersion: 'knowledge-bits.package.v1',
    packageId,
    revision: 1,
    locale: 'en',
    owner: 'knowledge-team',
    riskClass: 'low',
    target: {
      kind: 'nuglet.lesson.v1',
      schemaVersion: '1.0.0',
      payload: {
        title: 'Build a rainy day fund',
        takeaway: 'A small reserve makes surprise costs easier to handle.',
        action: 'Choose a starter amount to set aside this week.',
        depths: {
          quick: 'Start with one small transfer.',
          core: 'A dedicated reserve separates surprise costs from normal spending.',
          deep: 'Build the reserve with repeatable transfers and review the target after major life changes.',
        },
        claims,
        claimCoverage: [
          { path: 'title', claimIds: [claimId] },
          { path: 'takeaway', claimIds: [claimId] },
          { path: 'action', claimIds: [claimId] },
          { path: 'depths.quick', claimIds: [claimId] },
          { path: 'depths.core', claimIds: [claimId] },
          { path: 'depths.deep', claimIds: [claimId] },
        ],
      },
    },
    surfaces: {
      manifest: artifactReference('manifest'),
      evidence: artifactReference('evidence'),
      content: artifactReference('content'),
      workflow: artifactReference('workflow'),
    },
    evidence: {
      schemaVersion: 'knowledge-bits.evidence.v1',
      acceptedSources: [{
        sourceId,
        url: 'https://example.com/source',
        title: 'Example source',
        retrievedAt: '2026-07-12T12:00:00.000Z',
        snapshot: { ...artifactReference('source_snapshot'), artifactId: snapshotArtifactId },
        readability: { passed: true, reason: null },
        credibility: { passed: true, policy: 'fixture-trusted-hosts.v1', reason: null },
      }],
      rejectedSources: [],
      coverageGaps: [],
      claims,
    },
    qa: {
      deterministic: { passed: true, contentChecksum: checksum, findings: [] },
      editorial: { summary: 'Ready for review.', findings: [] },
    },
    packageChecksum: checksum,
    approval: {
      status: 'unapproved',
      reviewerId: null,
      decidedAt: null,
      approvedChecksum: null,
      comment: null,
    },
  };
}

function storyPlaybookDraft() {
  const secondClaimId = '0f8fad5b-d9cb-469f-a165-708677289520';
  const claims = [
    {
      claimId,
      statement: 'A rainy day fund can help cover an unexpected expense.',
      citations: [{ sourceId, snapshotArtifactId, excerpt: 'An emergency fund covers unexpected expenses.' }],
    },
    {
      claimId: secondClaimId,
      statement: 'A small repeated transfer can build an emergency reserve.',
      citations: [{ sourceId, snapshotArtifactId, excerpt: 'Regular contributions can build savings over time.' }],
    },
  ];
  return {
    materialization: 'draft',
    contentModel: 'story-playbook.v1',
    identity: {
      locale: 'en-GB',
      topic: { label: 'Personal finance', categoryId: null },
      tags: ['saving', 'resilience'],
      title: 'Build a rainy day fund',
      deck: 'Why a small reserve makes surprise costs easier to handle.',
      slugSuggestion: 'build-a-rainy-day-fund',
    },
    learning: {
      centralIdea: 'A small reserve reduces the disruption caused by surprise costs.',
      whyItMatters: 'Unexpected expenses are easier to absorb when money is already set aside.',
      oneLineToKeep: 'Start with a buffer small enough to build consistently.',
      terminology: ['rainy day fund', 'reserve'],
      action: {
        label: 'Choose your first transfer',
        instruction: 'Set aside one affordable amount today.',
      },
    },
    hero: {
      altText: 'A small vessel collecting coins beside a growing seedling.',
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
        principle: 'Consistency matters more than a heroic first deposit.',
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
      mediaBrief: {
        objective: 'Explain how a small repeated transfer becomes a buffer.',
        structure: 'three-step loop',
      },
    },
    listen: {
      brief: {
        editorialBrief: {
          objective: 'Explain the central idea concisely.',
          tone: 'calm and practical',
          keyPoints: ['Start small.', 'Repeat the transfer.'],
        },
      },
      discussion: {
        editorialBrief: {
          objective: 'Explore the emotional friction around emergency saving.',
          tone: 'reflective and conversational',
          keyPoints: ['Avoid shame.', 'Choose a sustainable amount.'],
        },
      },
    },
    quiz: {
      questions: [
        {
          id: 'q1',
          prompt: 'What is the central idea?',
          options: [{ id: 'a', text: 'Start small' }, { id: 'b', text: 'Wait for more income' }, { id: 'c', text: 'Borrow first' }],
          correctOptionId: 'a',
          rationale: 'A repeatable small transfer builds the buffer.',
          reviewConcept: 'Consistency over size.',
          claimRefs: [secondClaimId],
        },
        {
          id: 'q2',
          prompt: 'Which action is practical today?',
          options: [{ id: 'a', text: 'Set aside an affordable amount' }, { id: 'b', text: 'Skip all bills' }, { id: 'c', text: 'Invest the rent' }],
          correctOptionId: 'a',
          rationale: 'The action must not create a new shortfall.',
          reviewConcept: 'Sustainable action.',
          claimRefs: [claimId],
        },
        {
          id: 'q3',
          prompt: 'What should you avoid?',
          options: [{ id: 'a', text: 'A dedicated reserve' }, { id: 'b', text: 'An unaffordable transfer' }, { id: 'c', text: 'A repeatable habit' }],
          correctOptionId: 'b',
          rationale: 'Saving should not create a new immediate shortfall.',
          reviewConcept: 'The boundary of the advice.',
          claimRefs: [claimId],
        },
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

function materializedStoryPlaybook() {
  const draft = storyPlaybookDraft();
  const mediaArtifact = (kind, mediaType) => ({
    ...artifactReference(kind),
    artifactId: kind === 'hero' ? '0f8fad5b-d9cb-469f-a165-708677289530'
      : kind === 'infographic' ? '0f8fad5b-d9cb-469f-a165-708677289531'
        : kind === 'audio_brief' ? '0f8fad5b-d9cb-469f-a165-708677289532'
          : '0f8fad5b-d9cb-469f-a165-708677289533',
    kind,
    mediaType,
    inputChecksum: 'b'.repeat(64),
  });
  return {
    ...draft,
    materialization: 'materialized',
    hero: {
      ...draft.hero,
      asset: mediaArtifact('hero', 'image/webp'),
      width: 1024,
      height: 768,
      focalPoint: { x: 0.54, y: 0.46 },
      cropSafeArea: { x: 0.12, y: 0.1, width: 0.76, height: 0.8 },
    },
    visual: {
      ...draft.visual,
      asset: mediaArtifact('infographic', 'image/webp'),
      width: 1600,
      height: 2000,
    },
    listen: {
      brief: {
        ...draft.listen.brief,
        asset: mediaArtifact('audio_brief', 'audio/mp4'),
        durationSeconds: 203,
        transcript: { source: 'final_audio_bytes', text: 'A small buffer can soften a surprise cost.', checksum: 'c'.repeat(64) },
      },
      discussion: {
        ...draft.listen.discussion,
        asset: mediaArtifact('audio_discussion', 'audio/mp4'),
        durationSeconds: 481,
        transcript: { source: 'final_audio_bytes', text: 'Let us examine why starting small can feel difficult.', checksum: 'd'.repeat(64) },
      },
    },
  };
}

test('uses the six approved stages and five visible states', () => {
  assert.deepEqual(workflowStageSchema.options, [
    'research', 'create', 'check', 'produce_assets', 'human_review', 'deliver',
  ]);
  assert.deepEqual(stageStateSchema.options, [
    'queued', 'running', 'waiting', 'needs_human', 'done',
  ]);
});

test('validates the complete Nuglet generation plan while keeping other briefs generic', () => {
  const generationPlan = validGenerationPlan();
  assert.deepEqual(nugletGenerationPlanSchema.parse(generationPlan), generationPlan);
  assert.deepEqual(
    knowledgeBitsRunBriefSchema.parse({
      baseline: { runId: 'fixture-run' },
      generationPlan,
      notebookLmNotebookId: 'notebook-fixture',
      productMetadata: { campaign: 'pilot' },
    }),
    {
      baseline: { runId: 'fixture-run' },
      generationPlan,
      notebookLmNotebookId: 'notebook-fixture',
      productMetadata: { campaign: 'pilot' },
    },
  );
  assert.deepEqual(
    knowledgeBitsRunBriefSchema.parse({ contentKind: 'another.product.v1', arbitrary: true }),
    { contentKind: 'another.product.v1', arbitrary: true },
  );
});

test('rejects missing and mismatched Nuglet recipe identities and checksums', () => {
  const missing = validGenerationPlan();
  delete missing.recipes.audioDiscussion;
  assert.equal(nugletGenerationPlanSchema.safeParse(missing).success, false);

  const mismatchedId = validGenerationPlan();
  mismatchedId.recipes.hero.id = 'nuglet.hero.other';
  assert.equal(nugletGenerationPlanSchema.safeParse(mismatchedId).success, false);

  const mismatchedChecksum = validGenerationPlan();
  mismatchedChecksum.recipes.story.checksum = `sha256:${'b'.repeat(63)}`;
  assert.equal(nugletGenerationPlanSchema.safeParse(mismatchedChecksum).success, false);

  const missingChecksum = validGenerationPlan();
  delete missingChecksum.recipes.hero.checksum;
  assert.equal(nugletGenerationPlanSchema.safeParse(missingChecksum).success, false);

  assert.equal(
    knowledgeBitsRunBriefSchema.safeParse({ generationPlan: missing }).success,
    false,
  );
  assert.equal(
    knowledgeBitsRunBriefSchema.safeParse({ contentKind: 'nuglet.lesson.v1' }).success,
    false,
  );
});

test('requires an inspectable immutable media baseline with complete NotebookLM generation evidence', () => {
  const missing = validGenerationPlan();
  delete missing.mediaBaseline;
  assert.equal(nugletGenerationPlanSchema.safeParse(missing).success, false);

  const missingEvidence = validGenerationPlan();
  delete missingEvidence.mediaBaseline.descriptor.artifacts.audioDiscussion.generation.prompt;
  assert.equal(nugletGenerationPlanSchema.safeParse(missingEvidence).success, false);

  const escapingPath = validGenerationPlan();
  escapingPath.mediaBaseline.descriptor.artifacts.infographic.path = '../other-run/infographic.webp';
  assert.equal(nugletGenerationPlanSchema.safeParse(escapingPath).success, false);
});

test('binds the Nuglet media baseline identity to the enclosing run brief', () => {
  const generationPlan = validGenerationPlan();
  const brief = {
    baseline: { runId: 'fixture-run' },
    generationPlan,
    notebookLmNotebookId: 'notebook-fixture',
  };
  assert.equal(knowledgeBitsRunBriefSchema.safeParse(brief).success, true);

  const wrongRun = structuredClone(brief);
  wrongRun.baseline.runId = 'another-run';
  assert.equal(knowledgeBitsRunBriefSchema.safeParse(wrongRun).success, false);

  const wrongNotebook = structuredClone(brief);
  wrongNotebook.notebookLmNotebookId = 'another-notebook';
  assert.equal(knowledgeBitsRunBriefSchema.safeParse(wrongNotebook).success, false);
});

test('enforces the strict Nuglet brief at run intake without narrowing compatible briefs', () => {
  const generationPlan = validGenerationPlan();
  const validBrief = {
    baseline: { runId: 'fixture-run' },
    generationPlan,
    notebookLmNotebookId: 'notebook-fixture',
  };
  const request = {
    title: 'Fixture run',
    locale: 'en',
    brief: validBrief,
    notebookLmNotebookId: 'notebook-fixture',
  };
  assert.equal(knowledgeBitsCreateRunRequestSchema.safeParse(request).success, true);

  const wrongRun = structuredClone(request);
  wrongRun.brief.baseline.runId = 'another-run';
  assert.equal(knowledgeBitsCreateRunRequestSchema.safeParse(wrongRun).success, false);

  const wrongBriefNotebook = structuredClone(request);
  wrongBriefNotebook.brief.notebookLmNotebookId = 'another-notebook';
  assert.equal(knowledgeBitsCreateRunRequestSchema.safeParse(wrongBriefNotebook).success, false);

  const wrongRequestNotebook = structuredClone(request);
  wrongRequestNotebook.notebookLmNotebookId = 'another-notebook';
  assert.equal(knowledgeBitsCreateRunRequestSchema.safeParse(wrongRequestNotebook).success, false);

  assert.equal(knowledgeBitsCreateRunRequestSchema.safeParse({
    title: 'Another product',
    locale: 'en',
    brief: { contentKind: 'another.product.v1', arbitrary: true },
    notebookLmNotebookId: 'another-notebook',
  }).success, true);
  assert.equal(knowledgeBitsCreateRunRequestSchema.safeParse({
    title: 'Legacy run',
    locale: 'en',
    brief: { objective: 'Keep the historical shape', notebookLmNotebookId: 'legacy-notebook' },
  }).success, true);
});

test('requires a strictly bound Nuglet replacement brief to prepare a legacy revision', () => {
  const brief = {
    baseline: { runId: 'fixture-run' },
    generationPlan: validGenerationPlan(),
    notebookLmNotebookId: 'notebook-fixture',
  };
  const request = {
    expectedRevision: 1,
    expectedPackageChecksum: checksum,
    notebookLmNotebookId: 'notebook-fixture',
    brief,
    comment: 'Replace the unreadable legacy package with the validated baseline.',
  };
  assert.deepEqual(prepareLegacyRevisionRequestSchema.parse(request), request);
  assert.equal(prepareLegacyRevisionRequestSchema.safeParse({ ...request, expectedRevision: 0 }).success, false);
  assert.equal(prepareLegacyRevisionRequestSchema.safeParse({ ...request, expectedPackageChecksum: 'not-a-checksum' }).success, false);
  assert.equal(prepareLegacyRevisionRequestSchema.safeParse({ ...request, notebookLmNotebookId: 'another-notebook' }).success, false);
  assert.equal(prepareLegacyRevisionRequestSchema.safeParse({ ...request, brief: { notebookLmNotebookId: 'notebook-fixture' } }).success, false);
  assert.deepEqual(prepareLegacyRevisionResponseSchema.parse({
    run: {
      id: packageId,
      title: 'Fixture run',
      locale: 'en',
      brief,
      notebookLmNotebookId: 'notebook-fixture',
      currentStage: 'research',
      currentRevision: 2,
      packageChecksum: null,
      approvedChecksum: null,
      reviewStatus: 'pending',
      stages: {},
      nextRetryAt: null,
      createdAt: '2026-07-15T12:00:00.000Z',
      updatedAt: '2026-07-15T12:00:00.000Z',
    },
    previousRevision: 1,
    previousPackageChecksum: checksum,
  }), {
    run: {
      id: packageId,
      title: 'Fixture run',
      locale: 'en',
      brief,
      notebookLmNotebookId: 'notebook-fixture',
      currentStage: 'research',
      currentRevision: 2,
      packageChecksum: null,
      approvedChecksum: null,
      reviewStatus: 'pending',
      stages: {},
      nextRetryAt: null,
      createdAt: '2026-07-15T12:00:00.000Z',
      updatedAt: '2026-07-15T12:00:00.000Z',
    },
    previousRevision: 1,
    previousPackageChecksum: checksum,
  });
});

test('requires distinct approved Brief and Discussion baseline artifacts', () => {
  const wrongBriefPath = validGenerationPlan();
  wrongBriefPath.mediaBaseline.descriptor.artifacts.audioBrief.path = 'audio/brief.m4a';
  assert.equal(nugletGenerationPlanSchema.safeParse(wrongBriefPath).success, false);

  const discussionAliasesBrief = validGenerationPlan();
  discussionAliasesBrief.mediaBaseline.descriptor.artifacts.audioDiscussion = structuredClone(
    discussionAliasesBrief.mediaBaseline.descriptor.artifacts.audioBrief,
  );
  assert.equal(nugletGenerationPlanSchema.safeParse(discussionAliasesBrief).success, false);

  for (const field of ['providerArtifactId', 'checksum']) {
    const alias = validGenerationPlan();
    alias.mediaBaseline.descriptor.artifacts.audioDiscussion[field]
      = alias.mediaBaseline.descriptor.artifacts.audioBrief[field];
    assert.equal(nugletGenerationPlanSchema.safeParse(alias).success, false, field);
  }
});

test('approval must bind the exact package checksum', () => {
  const input = validKnowledgeBits();
  input.approval = {
    status: 'approved',
    reviewerId: 'operator-1',
    decidedAt: '2026-07-12T12:00:00.000Z',
    approvedChecksum: 'different-checksum',
    comment: null,
  };
  assert.throws(() => knowledgeBitsSchema.parse(input), /approved checksum/i);
});

test('changes requested require a human comment', () => {
  const input = validKnowledgeBits();
  input.approval = {
    status: 'changes_requested',
    reviewerId: 'operator-1',
    decidedAt: '2026-07-12T12:00:00.000Z',
    approvedChecksum: null,
    comment: '',
  };
  assert.throws(() => knowledgeBitsSchema.parse(input), /comment/i);
});

test('accepts a complete unapproved package with all four surfaces', () => {
  assert.deepEqual(knowledgeBitsSchema.parse(validKnowledgeBits()).packageId, packageId);
});

test('review requests never accept a caller supplied reviewer identity', () => {
  assert.deepEqual(reviewRunRequestSchema.parse({
    decision: 'approve',
    packageChecksum: checksum,
  }), {
    decision: 'approve',
    packageChecksum: checksum,
  });
  assert.throws(() => reviewRunRequestSchema.parse({
    decision: 'approve',
    packageChecksum: checksum,
    reviewerId: 'browser-controlled',
  }));
});

test('delivery claims carry the immutable package handoff', () => {
  const claim = {
    jobId: '11111111-1111-4111-8111-111111111111',
    packageId,
    stage: 'deliver',
    claimedBy: 'delivery-worker',
    claimedAt: '2026-07-13T10:00:00.000Z',
    leaseExpiresAt: '2026-07-13T10:01:00.000Z',
    executionDeadlineAt: '2026-07-13T10:05:00.000Z',
    attempt: 1,
    revision: 1,
    input: { brief: { title: 'Build a rainy day fund' }, dependencies: [] },
  };
  assert.throws(() => jobClaimSchema.parse(claim), /immutable package identity/i);
  assert.equal(jobClaimSchema.parse({
    ...claim,
    deliveryId: '22222222-2222-4222-8222-222222222222',
    packageVersionId: '33333333-3333-4333-8333-333333333333',
    packageChecksum: checksum,
  }).packageVersionId, '33333333-3333-4333-8333-333333333333');
});

test('evidence citations resolve to accepted immutable source snapshots', () => {
  const evidence = validKnowledgeBits().evidence;
  assert.equal(knowledgeBitsEvidenceSchema.parse(evidence).acceptedSources[0].snapshot.artifactId, snapshotArtifactId);
  assert.throws(() => knowledgeBitsEvidenceSchema.parse({
    ...evidence,
    claims: [{
      ...evidence.claims[0],
      citations: [{ ...evidence.claims[0].citations[0], snapshotArtifactId: packageId }],
    }],
  }), /accepted snapshot/i);
  assert.throws(() => knowledgeBitsEvidenceSchema.parse({
    ...evidence,
    acceptedSources: [{
      ...evidence.acceptedSources[0],
      credibility: { passed: false, policy: 'fixture-trusted-hosts.v1', reason: 'host_not_trusted' },
    }],
  }), /accepted source/i);
});

test('the lesson payload requires complete claim coverage for every learner-facing field', () => {
  const content = { schemaVersion: 'knowledge-bits.content.v1', target: validKnowledgeBits().target };
  assert.equal(knowledgeBitsContentSchema.parse(content).target.payload.claimCoverage.length, 6);
  assert.throws(() => knowledgeBitsContentSchema.parse({
    ...content,
    target: {
      ...content.target,
      payload: { ...content.target.payload, claims: [], claimCoverage: [] },
    },
  }), /claim/i);
  assert.throws(() => knowledgeBitsContentSchema.parse({
    ...content,
    target: {
      ...content.target,
      payload: { ...content.target.payload, claimCoverage: content.target.payload.claimCoverage.slice(1) },
    },
  }), /coverage/i);
});

test('accepts explicitly versioned legacy Quick Core Deep targets', () => {
  const content = { schemaVersion: 'knowledge-bits.content.v1', target: validKnowledgeBits().target };
  assert.equal(knowledgeBitsContentSchema.parse(content).target.schemaVersion, '1.0.0');
});

test('normalizes pre-version legacy targets to schema 1.0.0', () => {
  const { schemaVersion: _schemaVersion, ...unversionedTarget } = validKnowledgeBits().target;
  const parsed = knowledgeBitsContentSchema.parse({
    schemaVersion: 'knowledge-bits.content.v1',
    target: unversionedTarget,
  });
  assert.equal(parsed.target.schemaVersion, '1.0.0');
  assert.equal(parsed.target.payload.title, 'Build a rainy day fund');
});

test('accepts semantic and materialized Story Playbook payloads for schema 1.1.0', () => {
  const draft = storyPlaybookDraft();
  const materialized = materializedStoryPlaybook();
  assert.equal(storyPlaybookDraftSchema.parse(draft).materialization, 'draft');
  assert.equal(storyPlaybookPayloadSchema.parse(materialized).materialization, 'materialized');
  assert.equal(knowledgeBitsContentSchema.parse({
    schemaVersion: 'knowledge-bits.content.v1',
    target: { kind: 'nuglet.lesson.v1', schemaVersion: '1.1.0', payload: draft },
  }).target.schemaVersion, '1.1.0');
  assert.equal(knowledgeBitsContentSchema.parse({
    schemaVersion: 'knowledge-bits.content.v1',
    target: { kind: 'nuglet.lesson.v1', schemaVersion: '1.1.0', payload: materialized },
  }).target.payload.materialization, 'materialized');
});

test('requires a non-empty canonical terminology list for Story Playbook drafts', () => {
  const draft = storyPlaybookDraft();
  delete draft.learning.terminology;
  assert.equal(storyPlaybookDraftSchema.safeParse(draft).success, false);

  const empty = storyPlaybookDraft();
  empty.learning.terminology = [];
  assert.equal(storyPlaybookDraftSchema.safeParse(empty).success, false);
});

test('exports the versioned Story Playbook draft contract descriptor and terminology normalization', () => {
  assert.equal('storyPlaybookDraftContractDescriptor' in contracts, true);
  assert.equal('storyPlaybookDraftTargetSchema' in contracts, true);
  assert.equal('normalizeNugletTerminologyTerm' in contracts, true);
  const descriptor = contracts.storyPlaybookDraftContractDescriptor;
  assert.equal(descriptor.descriptorVersion, 'nuglet.lesson.story-playbook-draft.contract.v1');
  assert.deepEqual(descriptor.target, { kind: 'nuglet.lesson.v1', schemaVersion: '1.1.0' });
  assert.equal(descriptor.structure.challenge.questionCount, 3);
  assert.deepEqual(descriptor.payloadShape.quiz.slice(0, 2), ['questions[].id', 'questions[].prompt']);
  assert.deepEqual(descriptor.payloadShape.read.story.slice(0, 2), ['title', 'estimatedMinutes']);
  assert.deepEqual(descriptor.payloadShape.read.playbook.slice(0, 2), ['title', 'estimatedMinutes']);
  assert.equal('story' in descriptor.payloadShape, false);
  assert.equal('playbook' in descriptor.payloadShape, false);
  assert.equal('challenge' in descriptor.payloadShape, false);
  assert.deepEqual(descriptor.structure.playbook.stepCount, { min: 3, max: 5 });
  assert.deepEqual(descriptor.claimCoveragePaths, [
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
  assert.equal(contracts.normalizeNugletTerminologyTerm('  Rainy-day\tFUND  '), 'rainy day fund');
});

test('validates the exact strict Story Playbook draft target without claim coverage coercion', () => {
  const target = { kind: 'nuglet.lesson.v1', schemaVersion: '1.1.0', payload: storyPlaybookDraft() };
  const schema = contracts.storyPlaybookDraftTargetSchema;

  assert.equal(schema.safeParse(target).success, true);
  assert.equal(schema.safeParse({ ...target, unexpected: true }).success, false);
  assert.equal(schema.safeParse({
    ...target,
    payload: {
      ...target.payload,
      claimCoverage: Object.fromEntries(target.payload.claimCoverage.map(({ path, claimIds }) => [path, claimIds])),
    },
  }).success, false);
});

test('keeps the target schema versions structurally separate', () => {
  const legacy = validKnowledgeBits().target;
  const story = { kind: 'nuglet.lesson.v1', schemaVersion: '1.1.0', payload: storyPlaybookDraft() };
  assert.throws(() => knowledgeBitsContentSchema.parse({
    schemaVersion: 'knowledge-bits.content.v1',
    target: { ...story, schemaVersion: '1.0.0' },
  }));
  assert.throws(() => knowledgeBitsContentSchema.parse({
    schemaVersion: 'knowledge-bits.content.v1',
    target: { ...legacy, schemaVersion: '1.1.0' },
  }));
});

test('requires narrative Story blocks and three to five Playbook steps', () => {
  const draft = storyPlaybookDraft();
  assert.throws(() => storyPlaybookDraftSchema.parse({
    ...draft,
    read: { ...draft.read, story: { ...draft.read.story, blocks: [] } },
  }), /blocks/i);
  assert.throws(() => storyPlaybookDraftSchema.parse({
    ...draft,
    read: { ...draft.read, playbook: { ...draft.read.playbook, steps: draft.read.playbook.steps.slice(0, 2) } },
  }), /steps/i);
  assert.throws(() => storyPlaybookDraftSchema.parse({
    ...draft,
    read: { ...draft.read, playbook: { ...draft.read.playbook, steps: [...draft.read.playbook.steps, ...draft.read.playbook.steps] } },
  }), /steps/i);
});

test('requires claim coverage for Story and Playbook learner paths', () => {
  const draft = storyPlaybookDraft();
  assert.throws(() => storyPlaybookDraftSchema.parse({
    ...draft,
    claimCoverage: draft.claimCoverage.filter((entry) => entry.path !== 'read.story'),
  }), /read\.story/i);
  assert.throws(() => storyPlaybookDraftSchema.parse({
    ...draft,
    claimCoverage: draft.claimCoverage.filter((entry) => entry.path !== 'read.playbook'),
  }), /read\.playbook/i);
});

test('requires every nested Story Playbook visual and quiz claim reference to be declared', () => {
  const undeclaredClaimId = '0f8fad5b-d9cb-469f-a165-708677289599';
  const cases = [
    (draft) => {
      draft.read.story.blocks[0].claimRefs = [undeclaredClaimId];
    },
    (draft) => {
      draft.read.playbook.steps[0].claimRefs = [undeclaredClaimId];
    },
    (draft) => {
      draft.read.playbook.example.claimRefs = [undeclaredClaimId];
    },
    (draft) => {
      draft.visual.claimRefs = [undeclaredClaimId];
    },
    (draft) => {
      draft.quiz.questions[0].claimRefs = [undeclaredClaimId];
    },
  ];

  for (const mutate of cases) {
    const draft = storyPlaybookDraft();
    mutate(draft);
    assert.throws(() => storyPlaybookDraftSchema.parse(draft), /declared claim/i);
  }
});

test('requires nested claim references to appear in their learner path coverage', () => {
  const cases = [
    ['read.story', (draft) => {
      draft.read.story.blocks[0].claimRefs = [draft.claims[1].claimId];
    }],
    ['read.playbook', (draft) => {
      draft.read.playbook.steps[0].claimRefs = [draft.claims[1].claimId];
    }],
    ['read.playbook', (draft) => {
      draft.read.playbook.example.claimRefs = [draft.claims[1].claimId];
    }],
    ['visual', (draft) => {
      draft.visual.claimRefs = [draft.claims[1].claimId];
    }],
    ['quiz', (draft) => {
      draft.quiz.questions[0].claimRefs = [draft.claims[1].claimId];
    }],
  ];

  for (const [path, mutate] of cases) {
    const draft = storyPlaybookDraft();
    mutate(draft);
    draft.claimCoverage = draft.claimCoverage.map((entry) => (
      entry.path === path ? { ...entry, claimIds: [draft.claims[0].claimId] } : entry
    ));
    assert.throws(() => storyPlaybookDraftSchema.parse(draft), /learner path coverage/i);
  }
});

test('requires four distinct review assets and complete generation execution links', () => {
  const knowledgeBits = validKnowledgeBits();
  const execution = (role, recipeId, index) => ({
    role,
    recipe: {
      id: recipeId,
      version: '1.0.0',
      checksum: `sha256:${checksum}`,
    },
    jobId: `50000000-0000-4000-8000-0000000000${index}0`,
    executionId: `execution-${index}`,
    model: 'fixture-model',
    outputKind: ['story', 'playbook', 'quiz'].includes(role)
      ? 'parsed_output'
      : role === 'audioBrief'
      ? 'audio_brief'
      : role === 'audioDiscussion'
        ? 'audio_discussion'
        : role,
    outputChecksum: `sha256:${checksum}`,
    promptChecksum: `sha256:${checksum}`,
    referenceChecksums: [],
    recipeSnapshot: {
      ...artifactReference('generation.recipe.snapshot'),
      artifactId: `40000000-0000-4000-8000-0000000000${index}1`,
    },
    renderedPrompt: {
      ...artifactReference('generation.prompt.rendered'),
      artifactId: `40000000-0000-4000-8000-0000000000${index}2`,
    },
    executionReport: {
      ...artifactReference('generation.execution.report'),
      artifactId: `40000000-0000-4000-8000-0000000000${index}3`,
    },
  });
  const available = (artifactId, mediaType) => ({
    state: 'available',
    artifactId,
    mediaType,
    previewPath: `/artifacts/${artifactId}`,
  });
  const model = {
    runId: packageId,
    title: 'Build a rainy day fund',
    currentStage: 'human_review',
    currentRevision: 1,
    reviewStatus: 'pending',
    currentPackageChecksum: checksum,
    decisionAllowed: true,
    issues: [],
    warnings: ['Editorial warning: unsupported-claim: A claim is unsupported.'],
    package: {
      id: 'review-package-1',
      schemaVersion: 'knowledge-bits.review-package.v1',
      packageId,
      revision: 1,
      packageChecksum: checksum,
      adapterVersion: 'knowledge-bits.review-package.v1',
      locale: 'en',
      owner: 'knowledge-team',
      usageRights: { scope: 'internal-review' },
      content: { schemaVersion: 'knowledge-bits.content.v1', target: knowledgeBits.target },
      evidence: knowledgeBits.evidence,
      qa: knowledgeBits.qa,
      artifactInventory: [],
    },
    assets: {
      hero: available('0f8fad5b-d9cb-469f-a165-708677289530', 'image/webp'),
      infographic: available('0f8fad5b-d9cb-469f-a165-708677289531', 'image/webp'),
      audioBrief: available('0f8fad5b-d9cb-469f-a165-708677289532', 'audio/mp4'),
      audioDiscussion: available('0f8fad5b-d9cb-469f-a165-708677289533', 'audio/mp4'),
    },
    generationExecutions: {
      story: [execution('story', recipeIds.story, 1)],
      playbook: [execution('playbook', recipeIds.playbook, 2)],
      quiz: [execution('quiz', recipeIds.challenge, 3)],
      hero: [execution('hero', recipeIds.hero, 4)],
      infographic: [execution('infographic', recipeIds.infographic, 5)],
      audioBrief: [execution('audioBrief', recipeIds.audioBrief, 6)],
      audioDiscussion: [execution('audioDiscussion', recipeIds.audioDiscussion, 7)],
    },
  };

  assert.equal(reviewReadModelSchema.safeParse(model).success, true);
  assert.equal(reviewReadModelSchema.safeParse({
    ...model,
    assets: {
      hero: model.assets.hero,
      infographic: model.assets.infographic,
      audio: model.assets.audioBrief,
    },
  }).success, false);
  assert.equal(reviewReadModelSchema.safeParse({
    ...model,
    generationExecutions: {
      ...model.generationExecutions,
      hero: [{ ...model.generationExecutions.hero[0], renderedPrompt: undefined }],
    },
  }).success, false);
  assert.equal(reviewReadModelSchema.safeParse({
    ...model,
    generationExecutions: {
      ...model.generationExecutions,
      hero: [{ ...model.generationExecutions.hero[0], outputChecksum: undefined }],
    },
  }).success, false);
});

test('materialized media references enforce artifact kind and media type roles', () => {
  const cases = [
    (payload) => { payload.hero.asset.kind = 'infographic'; },
    (payload) => { payload.hero.asset.mediaType = 'application/json'; },
    (payload) => { payload.visual.asset.kind = 'hero'; },
    (payload) => { payload.visual.asset.mediaType = 'application/json'; },
    (payload) => { payload.listen.brief.asset.kind = 'audio_discussion'; },
    (payload) => { payload.listen.brief.asset.mediaType = 'application/json'; },
    (payload) => { payload.listen.discussion.asset.kind = 'audio_brief'; },
    (payload) => { payload.listen.discussion.asset.mediaType = 'application/json'; },
  ];

  for (const mutate of cases) {
    const payload = materializedStoryPlaybook();
    mutate(payload);
    assert.throws(() => storyPlaybookPayloadSchema.parse(payload));
  }
});

test('draft media briefs cannot claim final assets or transcripts', () => {
  const draft = storyPlaybookDraft();
  assert.throws(() => storyPlaybookDraftSchema.parse({
    ...draft,
    listen: {
      ...draft.listen,
      brief: { ...draft.listen.brief, transcript: 'This is only a planned script.' },
    },
  }));
  assert.throws(() => storyPlaybookPayloadSchema.parse({
    ...materializedStoryPlaybook(),
    listen: {
      ...materializedStoryPlaybook().listen,
      brief: {
        ...materializedStoryPlaybook().listen.brief,
        transcript: { source: 'planned_script', text: 'A planned script.', checksum: 'c'.repeat(64) },
      },
    },
  }));
});

test('QA requires the engine-calculated content checksum and explicit blocking findings', () => {
  assert.equal(knowledgeBitsQaSchema.parse(validKnowledgeBits().qa).deterministic.contentChecksum, checksum);
  assert.throws(() => knowledgeBitsQaSchema.parse({
    deterministic: { passed: true, findings: [] },
    editorial: { summary: 'Ready.', findings: [] },
  }), /contentChecksum/i);
  assert.equal(knowledgeBitsQaSchema.parse({
    deterministic: { passed: true, contentChecksum: checksum, findings: [] },
    editorial: {
      summary: 'Blocked.',
      findings: [{ code: 'unsupported-claim', severity: 'major', blocking: true, message: 'Missing support.' }],
    },
  }).editorial.findings[0].blocking, true);
});

test('job outcomes distinguish configuration action from quality revision', () => {
  const base = {
    jobId: '11111111-1111-4111-8111-111111111111',
    packageId,
    stage: 'research',
    state: 'needs_human',
    completedAt: '2026-07-13T10:00:00.000Z',
    outputChecksum: null,
    error: 'provider_runtime_unconfigured:notebooklm',
  };
  assert.throws(() => jobResultSchema.parse(base), /needsHumanKind/i);
  assert.equal(jobResultSchema.parse({ ...base, needsHumanKind: 'configuration' }).needsHumanKind, 'configuration');
});
