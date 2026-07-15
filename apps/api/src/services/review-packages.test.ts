import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateContentChecksum } from '@knowledge-bits/pipeline';
import type { NugletGenerationPlan, NugletLessonV1Payload } from '@knowledge-bits/contracts';

import type { ArtifactStorageAdapter } from './artifacts.js';
import {
  ArtifactStorageObjectNotFoundError,
} from './artifacts.js';
import {
  assembleGenerationExecutions,
  ReviewPackageService,
} from './review-packages.js';
import { createApp } from '../app.js';
import {
  createInMemoryWorkflowStore,
  WorkflowRepository,
  type WorkflowArtifact,
} from '../repositories/workflow-repository.js';

const runId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const workerChecksum = 'f'.repeat(64);
const sourceId = '11111111-1111-4111-8111-111111111111';
const claimId = '11111111-1111-4111-8111-111111111112';
const snapshotArtifactId = '20000000-0000-4000-8000-000000000000';

class ReadableStorage implements ArtifactStorageAdapter {
  readonly objects = new Map<string, { body: Uint8Array; mediaType: string }>();
  readError: Error | null = null;

  async preparePut(): Promise<{ uploadUrl: string; requiredHeaders: Record<string, string> }> {
    throw new Error('not used');
  }

  async inspect(storageKey: string) {
    const object = this.objects.get(storageKey);
    if (!object) throw new Error('missing');
    return { checksum: 'a'.repeat(64), byteSize: object.body.byteLength, mediaType: object.mediaType };
  }

  async read(storageKey: string) {
    if (this.readError) throw this.readError;
    const object = this.objects.get(storageKey);
    if (!object) throw new Error('missing');
    return object.body;
  }
}

test('assembles and persists one checksum-bound review model from accepted artifacts', async () => {
  const { repository, storage } = await fixture();
  const service = new ReviewPackageService({ repository, storage });

  const model = await service.load(runId);
  const replay = await service.load(runId);
  const run = await repository.getRun(runId);
  const persisted = await repository.getPackageVersion(runId, model.package!.packageChecksum);

  assert.equal(model.decisionAllowed, true);
  assert.equal(model.package?.content.target.payload.title, 'Return to one task');
  assert.equal(model.package?.evidence.acceptedSources[0]?.title, 'Focused work evidence');
  assert.equal(model.package?.qa.deterministic.passed, true);
  assert.equal(model.assets.hero.state, 'available');
  assert.ok(model.package?.artifactInventory.some((artifact) => artifact.kind === 'execution_report'));
  assert.ok(Object.values(model.generationExecutions).every((executions) => executions.length === 0));
  assert.match(model.assets.hero.previewPath ?? '', new RegExp(`/runs/${runId}/artifacts/`));
  assert.notEqual(model.package?.packageChecksum, workerChecksum);
  assert.equal(run?.packageChecksum, model.package?.packageChecksum);
  assert.equal(replay.package?.id, model.package?.id);
  assert.equal(persisted?.id, model.package?.id);
});

test('keeps explicit missing asset states but blocks decisions when package data is unreadable', async () => {
  const { repository, storage, artifactKeys } = await fixture({ includeMedia: false });
  storage.objects.set(artifactKeys.content, { body: Buffer.from('{'), mediaType: 'application/json' });
  const service = new ReviewPackageService({ repository, storage });

  const model = await service.load(runId);

  assert.equal(model.decisionAllowed, false);
  assert.equal(model.package, null);
  assert.equal(model.assets.hero.state, 'missing');
  assert.match(model.issues.join(' '), /content.*unreadable/i);
});

test('blocks decisions when only required review media is missing', async () => {
  const { repository, storage } = await fixture({ includeMedia: false });
  const service = new ReviewPackageService({ repository, storage });

  const model = await service.load(runId);

  assert.equal(model.package?.content.target.payload.title, 'Return to one task');
  assert.equal(model.decisionAllowed, false);
  assert.equal(model.assets.hero.state, 'missing');
  assert.equal(model.assets.infographic.state, 'missing');
  assert.equal(model.assets.audioBrief.state, 'missing');
  assert.equal(model.assets.audioDiscussion.state, 'missing');
  assert.match(model.issues.join(' '), /required review media/i);

  const app = createApp({
    repository,
    artifactStorage: storage,
    env: {
      ENGINE_API_TOKEN: 'api-token',
      ENGINE_REVIEW_TOKEN: 'review-token',
    },
  });
  const decision = await app.request(`/runs/${runId}/review`, {
    method: 'POST',
    headers: { Authorization: 'Bearer review-token', 'X-Knowledge-Bits-Reviewer': 'review-principal' },
    body: JSON.stringify({ decision: 'approve', packageChecksum: model.package?.packageChecksum }),
  });
  assert.equal(decision.status, 409, await decision.clone().text());
});

test('joins every Story Playbook and media execution to complete inspectable provenance', () => {
  const { artifacts, plan } = generationProvenanceFixture();

  const executions = assembleGenerationExecutions(artifacts, plan);

  assert.deepEqual(Object.keys(executions), [
    'story',
    'playbook',
    'quiz',
    'hero',
    'infographic',
    'audioBrief',
    'audioDiscussion',
  ]);
  assert.equal(executions.story.length, 1);
  assert.equal(executions.playbook.length, 1);
  assert.equal(executions.quiz.length, 1);
  assert.equal(executions.audioBrief.length, 2);
  assert.equal(executions.audioDiscussion.length, 2);
  for (const entries of Object.values(executions)) {
    for (const execution of entries) {
      assert.equal(execution.recipeSnapshot.kind, 'generation.recipe.snapshot');
      assert.equal(execution.renderedPrompt.kind, 'generation.prompt.rendered');
      assert.equal(execution.executionReport.kind, 'generation.execution.report');
    }
  }
});

test('blocks 1.1.0 provenance assembly when a recipe prompt or current execution report is missing', () => {
  const missingPrompt = generationProvenanceFixture();
  missingPrompt.artifacts = missingPrompt.artifacts.filter((artifact) => !(
    artifact.kind === 'generation.prompt.rendered'
    && artifact.provenance.recipeId === missingPrompt.plan.recipes.hero.id
  ));
  assert.throws(
    () => assembleGenerationExecutions(missingPrompt.artifacts, missingPrompt.plan),
    /hero.*rendered prompt|provenance.*hero/i,
  );

  const legacyReport = generationProvenanceFixture('execution_report');
  assert.doesNotThrow(() => legacyReport.artifacts.find((artifact) => artifact.kind === 'execution_report'));
  assert.throws(
    () => assembleGenerationExecutions(legacyReport.artifacts, legacyReport.plan),
    /execution report/i,
  );

  const mismatchedProfile = generationProvenanceFixture();
  const heroSnapshot = mismatchedProfile.artifacts.find((artifact) => (
    artifact.kind === 'generation.recipe.snapshot'
    && artifact.provenance.recipeId === mismatchedProfile.plan.recipes.hero.id
  ));
  assert.ok(heroSnapshot);
  heroSnapshot.checksum = 'f'.repeat(64);
  assert.throws(
    () => assembleGenerationExecutions(mismatchedProfile.artifacts, mismatchedProfile.plan),
    /hero.*recipe snapshot checksum/i,
  );
});

test('binds selected outputs to complete evidence from the same execution', () => {
  const missing = generationProvenanceFixture();
  for (const artifact of missing.artifacts) {
    if (artifact.provenance.recipeId === missing.plan.recipes.hero.id) {
      delete artifact.provenance.outputChecksum;
    }
    if (Array.isArray(artifact.provenance.generationExecutions)) {
      artifact.provenance.generationExecutions = artifact.provenance.generationExecutions.map((execution) => (
        isFixtureRecord(execution) && execution.recipeId === missing.plan.recipes.hero.id
          ? Object.fromEntries(Object.entries(execution).filter(([key]) => key !== 'outputChecksum'))
          : execution
      ));
    }
  }
  assert.throws(
    () => assembleGenerationExecutions(missing.artifacts, missing.plan),
    /hero.*output|hero.*provenance/i,
  );

  const mismatch = generationProvenanceFixture();
  const heroPrompt = mismatch.artifacts.find((artifact) => (
    artifact.kind === 'generation.prompt.rendered'
    && artifact.provenance.recipeId === mismatch.plan.recipes.hero.id
  ));
  assert.ok(heroPrompt);
  heroPrompt.provenance.outputChecksum = `sha256:${'f'.repeat(64)}`;
  assert.throws(
    () => assembleGenerationExecutions(mismatch.artifacts, mismatch.plan),
    /hero.*output|hero.*provenance/i,
  );

  const foreign = generationProvenanceFixture();
  const selectedHero = foreign.artifacts.find((artifact) => artifact.kind === 'hero');
  assert.ok(selectedHero);
  selectedHero.provenance.idempotencyKey = 'foreign-execution';
  assert.throws(
    () => assembleGenerationExecutions(foreign.artifacts, foreign.plan),
    /hero.*execution/i,
  );
});

test('blocks approval for failed deterministic QA or stale asset inputs', async () => {
  for (const options of [
    { qaPassed: false },
    { assetInputChecksum: 'd'.repeat(64) },
  ]) {
    const { repository, storage } = await fixture(options);
    const model = await new ReviewPackageService({ repository, storage }).load(runId);
    assert.equal(model.decisionAllowed, false);
    assert.ok(model.package);
    assert.match(model.issues.join(' '), /deterministic|checksum/i);
  }
});

test('keeps blocking editorial findings as decision-ready review warnings', async () => {
  const { repository, storage } = await fixture({ blockingEditorial: true });

  const model = await new ReviewPackageService({ repository, storage }).load(runId);

  assert.equal(model.decisionAllowed, true);
  assert.deepEqual(model.issues, []);
  assert.deepEqual(model.warnings, [
    'Editorial warning: unsupported-claim: A claim is unsupported.',
  ]);
});

test('keeps editorial warnings visible when a separate hard gate blocks decisions', async () => {
  const { repository, storage } = await fixture({ blockingEditorial: true, qaPassed: false });

  const model = await new ReviewPackageService({ repository, storage }).load(runId);

  assert.equal(model.decisionAllowed, false);
  assert.match(model.issues.join(' '), /deterministic/i);
  assert.deepEqual(model.warnings, [
    'Editorial warning: unsupported-claim: A claim is unsupported.',
  ]);
});

test('keeps editorial warnings visible when a separate media assembly failure blocks decisions', async () => {
  const { repository, storage, artifactKeys } = await fixture({ blockingEditorial: true });
  storage.objects.delete(artifactKeys.hero);

  const model = await new ReviewPackageService({ repository, storage }).load(runId);

  assert.equal(model.decisionAllowed, false);
  assert.match(model.issues.join(' '), /missing|unreadable/i);
  assert.deepEqual(model.warnings, [
    'Editorial warning: unsupported-claim: A claim is unsupported.',
  ]);
});

test('excludes superseded assets so approval is bound to the displayed canonical package', async () => {
  const { repository, storage, mediaId, staleMediaId } = await fixture({ includeStaleHero: true });
  const service = new ReviewPackageService({ repository, storage });

  const model = await service.load(runId);
  const packagedHeroes = model.package?.artifactInventory.filter((artifact) => artifact.kind === 'hero');

  assert.equal(model.decisionAllowed, true);
  assert.equal(model.assets.hero.artifactId, mediaId);
  assert.deepEqual(packagedHeroes?.map((artifact) => artifact.artifactId), [mediaId]);
  assert.ok(!model.package?.artifactInventory.some((artifact) => artifact.artifactId === staleMediaId));
  await assert.rejects(service.readArtifact(runId, staleMediaId!), /artifact.*package/i);

  const app = createApp({
    repository,
    artifactStorage: storage,
    env: {
      ENGINE_API_TOKEN: 'api-token',
      ENGINE_REVIEW_TOKEN: 'review-token',
    },
  });
  const decision = await app.request(`/runs/${runId}/review`, {
    method: 'POST',
    headers: { Authorization: 'Bearer review-token', 'X-Knowledge-Bits-Reviewer': 'review-principal' },
    body: JSON.stringify({ decision: 'approve', packageChecksum: model.package?.packageChecksum }),
  });
  assert.equal(decision.status, 200, await decision.clone().text());
});

test('reads only an artifact included in the current immutable package', async () => {
  const { repository, storage, mediaId } = await fixture();
  const service = new ReviewPackageService({ repository, storage });
  await service.load(runId);

  const artifact = await service.readArtifact(runId, mediaId!);
  assert.equal(Buffer.from(artifact.body).toString(), 'hero-image');
  assert.equal(artifact.mediaType, 'image/webp');
  await assert.rejects(service.readArtifact(runId, '99999999-9999-4999-8999-999999999999'), /artifact.*package/i);
});

test('serves the review model and artifact bytes only to the configured review principal', async () => {
  const { repository, storage, mediaId } = await fixture();
  const app = createApp({
    repository,
    artifactStorage: storage,
    env: {
      ENGINE_API_TOKEN: 'api-token',
      ENGINE_REVIEW_TOKEN: 'review-token',
    },
  });

  const missingAuth = await app.request(`/runs/${runId}/review`);
  assert.equal(missingAuth.status, 401);
  const response = await app.request(`/runs/${runId}/review`, {
    headers: { Authorization: 'Bearer review-token', 'X-Knowledge-Bits-Reviewer': 'review-principal' },
  });
  assert.equal(response.status, 200, await response.clone().text());
  const model = await response.json() as { decisionAllowed: boolean; package: { packageChecksum: string } };
  assert.equal(model.decisionAllowed, true);

  const artifact = await app.request(`/runs/${runId}/artifacts/${mediaId}`, {
    headers: { Authorization: 'Bearer review-token' },
  });
  assert.equal(artifact.status, 200);
  assert.equal(await artifact.text(), 'hero-image');
  assert.equal(artifact.headers.get('content-type'), 'image/webp');
});

test('maps authenticated artifact-read object misses to 404 and generic adapter failures to 503', async () => {
  const { repository, storage, mediaId } = await fixture();
  const app = createApp({
    repository,
    artifactStorage: storage,
    env: {
      ENGINE_API_TOKEN: 'api-token',
      ENGINE_REVIEW_TOKEN: 'review-token',
    },
  });
  const headers = { Authorization: 'Bearer review-token', 'X-Knowledge-Bits-Reviewer': 'review-principal' };
  const loaded = await app.request(`/runs/${runId}/review`, { headers });
  assert.equal(loaded.status, 200);

  storage.readError = new ArtifactStorageObjectNotFoundError('Stored artifact is missing');
  const missing = await app.request(`/runs/${runId}/artifacts/${mediaId}`, { headers });
  assert.equal(missing.status, 404, await missing.clone().text());

  storage.readError = new Error('adapter connection reset');
  const unavailable = await app.request(`/runs/${runId}/artifacts/${mediaId}`, { headers });
  assert.equal(unavailable.status, 503, await unavailable.clone().text());
});

async function fixture(options: {
  includeMedia?: boolean;
  includeStaleHero?: boolean;
  qaPassed?: boolean;
  blockingEditorial?: boolean;
  assetInputChecksum?: string;
} = {}) {
  const repository = new WorkflowRepository(createInMemoryWorkflowStore());
  repository.listArtifactsForSuccessfulStageJobs = (id, revision) => repository.listArtifacts(id, revision);
  const storage = new ReadableStorage();
  await repository.createRun({
    id: runId,
    title: 'Return to one task',
    locale: 'en',
    brief: { objective: 'Make one focused next step.' },
    currentStage: 'human_review',
    packageChecksum: workerChecksum,
    stages: [{ name: 'human_review', state: 'needs_human' }],
  });

  const artifactKeys = {
    evidence: 'objects/evidence',
    content: 'objects/content',
    qa: 'objects/qa',
    legacyExecutionReport: 'objects/legacy-execution-report',
    hero: 'objects/hero',
    infographic: 'objects/infographic',
    audioBrief: 'objects/audio-brief',
    audioDiscussion: 'objects/audio-discussion',
    staleHero: 'objects/stale-hero',
    snapshot: 'objects/snapshot',
  };
  const inputs: Array<{
    id: string;
    kind: string;
    storageKey: string;
    action: string;
    mediaType: string;
    body: unknown;
    inputChecksum?: string | null;
    provenance?: Record<string, unknown>;
  }> = [
    {
      id: snapshotArtifactId,
      kind: 'source_snapshot',
      storageKey: artifactKeys.snapshot,
      action: 'collect_sources',
      mediaType: 'text/plain',
      body: 'A short reset followed by one written next action can reduce restart friction.',
      provenance: { sourceId },
    },
    {
      id: '20000000-0000-4000-8000-000000000001',
      kind: 'parsed_output',
      storageKey: artifactKeys.evidence,
      action: 'collect_sources',
      mediaType: 'application/json',
      body: {
        acceptedSources: [{
          sourceId,
          title: 'Focused work evidence',
          url: 'https://example.test/focused-work',
          retrievedAt: '2026-07-13T10:00:00.000Z',
          snapshotChecksum: 'a'.repeat(64),
          readability: { passed: true, reason: null },
          credibility: { passed: true, policy: 'fixture-trusted-hosts.v1', reason: null },
        }],
        rejectedSources: [],
        coverageGaps: [],
      },
    },
    {
      id: '20000000-0000-4000-8000-000000000002',
      kind: 'parsed_output',
      storageKey: artifactKeys.content,
      action: 'create_content',
      mediaType: 'application/json',
      body: contentOutput(),
    },
    {
      id: '20000000-0000-4000-8000-000000000009',
      kind: 'execution_report',
      storageKey: artifactKeys.legacyExecutionReport,
      action: 'create_content',
      mediaType: 'application/json',
      body: { provider: 'historical-fixture', status: 'complete' },
    },
    {
      id: '20000000-0000-4000-8000-000000000003',
      kind: 'parsed_output',
      storageKey: artifactKeys.qa,
      action: 'check_content',
      mediaType: 'application/json',
      body: {
        deterministic: {
          passed: options.qaPassed !== false,
          contentChecksum: calculateContentChecksum(contentOutput()),
          findings: options.qaPassed === false ? [{ code: 'claim-coverage', message: 'Coverage is incomplete.' }] : [],
        },
        editorial: {
          summary: options.blockingEditorial ? 'Needs revision.' : 'Ready for structural review.',
          findings: options.blockingEditorial
            ? [{ code: 'unsupported-claim', severity: 'major', blocking: true, message: 'A claim is unsupported.' }]
            : [],
        },
      },
    },
  ];
  if (options.includeMedia !== false) {
    if (options.includeStaleHero) {
      inputs.push({
        id: '10000000-0000-4000-8000-000000000007',
        kind: 'hero',
        storageKey: artifactKeys.staleHero,
        action: 'produce_assets',
        mediaType: 'image/webp',
        body: 'stale-hero-image',
        inputChecksum: 'd'.repeat(64),
      });
    }
    inputs.push(
      {
        id: '20000000-0000-4000-8000-000000000004',
        kind: 'hero',
        storageKey: artifactKeys.hero,
        action: 'produce_assets',
        mediaType: 'image/webp',
        body: 'hero-image',
        inputChecksum: options.assetInputChecksum ?? calculateContentChecksum(contentOutput()),
      },
      {
        id: '20000000-0000-4000-8000-000000000005',
        kind: 'infographic',
        storageKey: artifactKeys.infographic,
        action: 'produce_assets',
        mediaType: 'image/webp',
        body: 'infographic-image',
        inputChecksum: options.assetInputChecksum ?? calculateContentChecksum(contentOutput()),
      },
      {
        id: '20000000-0000-4000-8000-000000000006',
        kind: 'audio_brief',
        storageKey: artifactKeys.audioBrief,
        action: 'produce_assets',
        mediaType: 'audio/mpeg',
        body: 'brief-audio-bytes',
        inputChecksum: options.assetInputChecksum ?? calculateContentChecksum(contentOutput()),
      },
      {
        id: '20000000-0000-4000-8000-000000000008',
        kind: 'audio_discussion',
        storageKey: artifactKeys.audioDiscussion,
        action: 'produce_assets',
        mediaType: 'audio/mpeg',
        body: 'discussion-audio-bytes',
        inputChecksum: options.assetInputChecksum ?? calculateContentChecksum(contentOutput()),
      },
    );
  }

  for (const input of inputs) {
    const bytes = typeof input.body === 'string' ? Buffer.from(input.body) : Buffer.from(JSON.stringify(input.body));
    storage.objects.set(input.storageKey, { body: bytes, mediaType: input.mediaType });
    await repository.recordArtifact({
      id: input.id,
      runId,
      revision: 1,
      kind: input.kind,
      mediaType: input.mediaType,
      checksum: 'a'.repeat(64),
      storageKey: input.storageKey,
      byteSize: bytes.byteLength,
      provenance: { action: input.action, provider: 'fixture', ...input.provenance },
      inputChecksum: input.inputChecksum ?? null,
      jobId: `30000000-0000-4000-8000-00000000000${inputs.indexOf(input) + 1}`,
      stage: input.action === 'collect_sources'
        ? 'research'
        : input.action === 'create_content'
          ? 'create'
          : input.action === 'check_content'
            ? 'check'
            : 'produce_assets',
      action: input.action,
    });
  }

  return {
    repository,
    storage,
    artifactKeys,
    mediaId: options.includeMedia === false ? null : '20000000-0000-4000-8000-000000000004',
    staleMediaId: options.includeStaleHero ? '10000000-0000-4000-8000-000000000007' : null,
  };
}

function generationProvenanceFixture(
  reportKind = 'generation.execution.report',
): { artifacts: WorkflowArtifact[]; plan: NugletGenerationPlan } {
  const binding = (id: string, digit: string) => ({
    id,
    version: '1.0.0',
    checksum: `sha256:${digit.repeat(64)}`,
  });
  const recipes = {
    story: binding('nuglet.lesson.story', '1'),
    playbook: binding('nuglet.lesson.playbook', '2'),
    challenge: binding('nuglet.challenge', '3'),
    infographic: binding('nuglet.visual.infographic', '4'),
    audioBrief: binding('nuglet.audio.brief', '5'),
    audioDiscussion: binding('nuglet.audio.discussion', '6'),
    hero: binding('nuglet.hero', '7'),
    editorialQa: binding('nuglet.qa.editorial', '8'),
  };
  const plan = { recipes } as NugletGenerationPlan;
  const artifacts: WorkflowArtifact[] = [];
  const createJobId = '70000000-0000-4000-8000-000000000001';
  const mediaJobId = '70000000-0000-4000-8000-000000000002';
  const contentOutput = addSelectedOutput(artifacts, 'parsed_output', createJobId, 'create_content', 'e');
  const heroOutput = addSelectedOutput(artifacts, 'hero', mediaJobId, 'produce_assets', '1');
  const infographicOutput = addSelectedOutput(artifacts, 'infographic', mediaJobId, 'produce_assets', '2');
  const audioBriefOutput = addSelectedOutput(artifacts, 'audio_brief', mediaJobId, 'produce_assets', '3');
  const audioDiscussionOutput = addSelectedOutput(artifacts, 'audio_discussion', mediaJobId, 'produce_assets', '4');
  const createExecutions = [recipes.story, recipes.playbook, recipes.challenge].map((recipe) => (
    addExecutionPair(artifacts, recipe, createJobId, 'create_content', 'a', contentOutput)
  ));
  const mediaExecutions = [
    addExecutionPair(artifacts, recipes.hero, mediaJobId, 'produce_assets', 'a', heroOutput, [
      `sha256:${'9'.repeat(64)}`,
      `sha256:${'a'.repeat(64)}`,
    ]),
    addExecutionPair(artifacts, recipes.infographic, mediaJobId, 'produce_assets', 'a', infographicOutput),
    addExecutionPair(artifacts, recipes.audioBrief, mediaJobId, 'produce_assets', 'a', audioBriefOutput),
    addExecutionPair(artifacts, recipes.audioBrief, mediaJobId, 'produce_assets', 'b', audioBriefOutput),
    addExecutionPair(artifacts, recipes.audioDiscussion, mediaJobId, 'produce_assets', 'a', audioDiscussionOutput),
    addExecutionPair(artifacts, recipes.audioDiscussion, mediaJobId, 'produce_assets', 'b', audioDiscussionOutput),
  ];
  artifacts.push(
    workflowArtifact({
      kind: reportKind,
      jobId: createJobId,
      action: 'create_content',
      checksum: 'c'.repeat(64),
      provenance: { generationExecutions: createExecutions },
    }),
    workflowArtifact({
      kind: reportKind,
      jobId: mediaJobId,
      action: 'produce_assets',
      checksum: 'd'.repeat(64),
      provenance: { generationExecutions: mediaExecutions },
    }),
  );
  return { artifacts, plan };
}

function addExecutionPair(
  artifacts: WorkflowArtifact[],
  recipe: NugletGenerationPlan['recipes'][keyof NugletGenerationPlan['recipes']],
  jobId: string,
  action: string,
  promptDigit: string,
  output: WorkflowArtifact,
  referenceChecksums: string[] = [],
) {
  const provenance = {
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    recipeChecksum: recipe.checksum,
    promptChecksum: `sha256:${promptDigit.repeat(64)}`,
    model: 'fixture-model',
    outputKind: output.kind,
    outputChecksum: `sha256:${output.checksum}`,
    referenceChecksums,
  };
  artifacts.push(
    workflowArtifact({
      kind: 'generation.recipe.snapshot',
      jobId,
      action,
      checksum: recipe.checksum.replace('sha256:', ''),
      provenance,
    }),
    workflowArtifact({
      kind: 'generation.prompt.rendered',
      jobId,
      action,
      checksum: promptDigit.repeat(64),
      provenance,
    }),
  );
  return provenance;
}

function addSelectedOutput(
  artifacts: WorkflowArtifact[],
  kind: string,
  jobId: string,
  action: string,
  checksumDigit: string,
): WorkflowArtifact {
  const output = workflowArtifact({
    kind,
    jobId,
    action,
    checksum: checksumDigit.repeat(64),
    provenance: {},
  });
  artifacts.push(output);
  return output;
}

function workflowArtifact(input: {
  kind: string;
  jobId: string;
  action: string;
  checksum: string;
  provenance: Record<string, unknown>;
}): WorkflowArtifact {
  const id = `80000000-0000-4000-8000-${String(provenanceArtifactCounter++).padStart(12, '0')}`;
  return {
    id,
    runId,
    revision: 1,
    kind: input.kind,
    mediaType: input.kind === 'generation.prompt.rendered' ? 'text/plain' : 'application/json',
    checksum: input.checksum,
    storageKey: `objects/${id}`,
    byteSize: 128,
    provenance: {
      action: input.action,
      jobId: input.jobId,
      idempotencyKey: `execution:${input.jobId}`,
      provider: 'fixture',
      ...input.provenance,
    },
    inputChecksum: null,
    jobId: input.jobId,
    stage: input.action === 'create_content' ? 'create' : 'produce_assets',
    action: input.action,
    createdAt: new Date('2026-07-15T10:00:00.000Z'),
  };
}

let provenanceArtifactCounter = 1;

function isFixtureRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contentOutput(): NugletLessonV1Payload {
  const citation = {
    sourceId,
    snapshotArtifactId,
    excerpt: 'A short reset followed by one written next action can reduce restart friction.',
  };
  return {
    title: 'Return to one task',
    takeaway: 'Name the next step.',
    action: 'Write the next step down.',
    depths: { quick: 'Name it.', core: 'Write it down.', deep: 'Remove restart friction.' },
    claims: [{ claimId, statement: 'A short reset can help.', citations: [citation] }],
    claimCoverage: [
      { path: 'title', claimIds: [claimId] },
      { path: 'takeaway', claimIds: [claimId] },
      { path: 'action', claimIds: [claimId] },
      { path: 'depths.quick', claimIds: [claimId] },
      { path: 'depths.core', claimIds: [claimId] },
      { path: 'depths.deep', claimIds: [claimId] },
    ],
  };
}
