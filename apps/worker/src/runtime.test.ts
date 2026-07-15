import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { calculateContentChecksum } from '@knowledge-bits/pipeline';
import type { NugletGenerationPlan } from '@knowledge-bits/contracts';

import {
  composeWorkerProviders,
  LeaseScopedJobContextResolver,
  LocalMediaCommandClient,
  LocalPiSdkClient,
  runProcess,
  type ProviderRuntime,
  type TrustedRecipeBindingVerifier,
} from './runtime.js';
import type { WorkerEngineClient } from './engine-client.js';
import type { ResolvedNugletRecipes } from './recipes/types.js';

const validProductRecipeRoots = {
  PRODUCT_RECIPE_ROOTS: '{"nuglet.lesson.v1":"/srv/recipes/nuglet.lesson.v1"}',
};

test('uses fixtures only when fixture mode is explicitly selected', () => {
  const production = composeWorkerProviders({ env: validProductRecipeRoots });
  const fixtures = composeWorkerProviders({ env: { WORKER_PROVIDER_MODE: 'fixture' } });

  assert.deepEqual(production.map(({ name }) => name), [
    'notebooklm-unavailable',
    'pi-unavailable',
    'media-unavailable',
  ]);
  assert.deepEqual(fixtures.map(({ name }) => name), ['fixture']);
});

test('production local-worker composition rejects missing or invalid product recipe roots', () => {
  for (const PRODUCT_RECIPE_ROOTS of [
    undefined,
    '',
    '[]',
    '{}',
    '{"nuglet.lesson.v1":"relative/recipes"}',
  ]) {
    assert.throws(
      () => composeWorkerProviders({ env: { WORKER_PROVIDER_MODE: 'production', PRODUCT_RECIPE_ROOTS } }),
      /product_recipe_roots_invalid/,
    );
  }
});

test('fixture provider composition does not require product recipe roots', () => {
  assert.deepEqual(
    composeWorkerProviders({ env: { WORKER_PROVIDER_MODE: 'fixture' } }).map(({ name }) => name),
    ['fixture'],
  );
});

test('missing production runtime configuration never returns fixture content', async () => {
  const [notebook] = composeWorkerProviders({ env: validProductRecipeRoots });
  assert.ok(notebook);

  await assert.rejects(
    () => notebook.execute(input('collect_sources')),
    /provider_runtime_unconfigured:notebooklm/,
  );
});

test('legacy provider service URLs do not create production provider dependencies', () => {
  const providers = composeWorkerProviders({
    env: {
      ...validProductRecipeRoots,
      PROVIDER_CONTEXT_URL: 'https://legacy.example.test',
      PI_EDITORIAL_URL: 'https://legacy.example.test/pi',
      MEDIA_GENERATION_URL: 'https://legacy.example.test/media',
    },
    fetch: async () => { throw new Error('legacy service must not be called'); },
  });
  assert.deepEqual(providers.map(({ name }) => name), [
    'notebooklm-unavailable', 'pi-unavailable', 'media-unavailable',
  ]);
});

test('composes injected production clients and context resolvers without live credentials', async () => {
  const runtime: ProviderRuntime = {
    notebookProcess: {
      async run() {
        return {
          stdout: JSON.stringify({ conversationId: 'notebook-1', answer: { claims: [], sources: [] } }),
          stderr: '',
          exitCode: 0,
        };
      },
    },
    notebookContext: async () => ({ notebookId: 'notebook-1', sourceUrls: [], topic: 'focus' }),
    sourceVerifier: {
      async verify() {
        return {
          evidence: {
            acceptedSources: [{
              sourceId: evidence.sources[0]!.sourceId,
              title: 'Evidence',
              url: 'https://example.test/evidence',
              retrievedAt: '2026-07-13T10:00:00.000Z',
              snapshotChecksum: inputChecksum,
              readability: { passed: true, reason: null },
              credibility: { passed: true, policy: 'fixture.v1', reason: null },
            }],
            rejectedSources: [],
            coverageGaps: [],
          },
          snapshots: [{ kind: 'source_snapshot', mediaType: 'text/plain', body: Buffer.from('evidence'), inputChecksum: null }],
        };
      },
    },
    piClient: { async check() { return { findings: [], summary: 'Ready.' }; } },
    piContext: async () => ({ candidate, evidence, rubric: 'Check it.' }),
    mediaClient: {
      async generate() {
        return [];
      },
    },
    mediaContext: async () => ({ passedCheck: true, content: candidate, contentChecksum: inputChecksum }),
  };

  const providers = composeWorkerProviders({ env: {}, runtime });
  assert.deepEqual(providers.map(({ name }) => name), ['notebooklm', 'pi', 'media']);

  const notebook = providers[0];
  assert.ok(notebook);
  const result = await notebook.execute(input('collect_sources'));
  assert.equal(result.kind, 'success');
});

test('reconstructs Pi and media context from lease-scoped artifact dependencies', async () => {
  const researchId = '66666666-6666-4666-8666-666666666661';
  const createId = '66666666-6666-4666-8666-666666666662';
  const checkId = '66666666-6666-4666-8666-666666666663';
  const bodies = new Map([
    [researchId, Buffer.from(JSON.stringify({
      acceptedSources: [{
        sourceId: evidence.sources[0]!.sourceId,
        title: evidence.sources[0]!.title,
        url: 'https://accepted.example.test/evidence',
      }],
    }))],
    [createId, Buffer.from(JSON.stringify(candidate))],
    [checkId, Buffer.from(JSON.stringify({
      deterministic: { passed: true, contentChecksum: calculateContentChecksum(candidate), findings: [] },
      editorial: { summary: 'Ready.', findings: [] },
    }))],
  ]);
  const client = contextClient(bodies);
  const resolver = new LeaseScopedJobContextResolver(client, acceptingRecipeVerifier());
  const dependencies = [
    { artifactId: researchId, revision: 1, kind: 'parsed_output', mediaType: 'application/json', checksum: inputChecksum, action: 'collect_sources' },
    { artifactId: evidence.sources[0]!.snapshotArtifactId, revision: 1, kind: 'source_snapshot', mediaType: 'text/plain', checksum: inputChecksum, action: 'collect_sources', sourceId: evidence.sources[0]!.sourceId },
    { artifactId: createId, revision: 1, kind: 'parsed_output', mediaType: 'application/json', checksum: inputChecksum, action: 'create_content' },
    { artifactId: checkId, revision: 1, kind: 'parsed_output', mediaType: 'application/json', checksum: inputChecksum, action: 'check_content' },
  ];
  const piInput = input('check_content', dependencies);
  const pi = await resolver.pi(piInput);
  const media = await resolver.media(input('produce_assets', dependencies));

  assert.deepEqual(pi.candidate, candidate);
  assert.deepEqual(pi.evidence, evidence);
  assert.equal(media.passedCheck, true);
  assert.equal(media.contentChecksum, calculateContentChecksum(candidate));
});

test('keeps a valid blocking legacy editorial QA response eligible for asset production', async () => {
  const createId = '66666666-6666-4666-8666-666666666661';
  const checkId = '66666666-6666-4666-8666-666666666662';
  const client = contextClient(new Map([
    [createId, Buffer.from(JSON.stringify(candidate))],
    [checkId, Buffer.from(JSON.stringify({
      deterministic: { passed: true, contentChecksum: calculateContentChecksum(candidate), findings: [] },
      editorial: {
        summary: 'Review this claim before publishing.',
        findings: [{
          code: 'unsupported-claim',
          severity: 'major',
          blocking: true,
          message: 'The claim needs a stronger source.',
        }],
      },
    }))],
  ]));
  const resolver = new LeaseScopedJobContextResolver(client, acceptingRecipeVerifier());
  const dependencies = [
    { artifactId: createId, revision: 1, kind: 'parsed_output', mediaType: 'application/json', checksum: inputChecksum, action: 'create_content' },
    { artifactId: checkId, revision: 1, kind: 'parsed_output', mediaType: 'application/json', checksum: inputChecksum, action: 'check_content' },
  ];

  const media = await resolver.media(input('produce_assets', dependencies));

  assert.equal(media.passedCheck, true);
  assert.equal(media.contentChecksum, calculateContentChecksum(candidate));
});

test('builds Create context from accepted source URLs instead of brief candidates', async () => {
  const researchId = '77777777-7777-4777-8777-777777777771';
  const snapshotId = evidence.sources[0]!.snapshotArtifactId;
  const acceptedUrl = 'https://accepted.example.test/evidence';
  const rejectedBriefUrl = 'https://rejected.example.test/candidate';
  const client = contextClient(new Map([
    [researchId, Buffer.from(JSON.stringify({
      acceptedSources: [{
        sourceId: evidence.sources[0]!.sourceId,
        title: evidence.sources[0]!.title,
        url: acceptedUrl,
      }],
    }))],
  ]));
  const resolver = new LeaseScopedJobContextResolver(client, acceptingRecipeVerifier());
  const dependencies = [
    { artifactId: researchId, revision: 1, kind: 'parsed_output', mediaType: 'application/json', checksum: inputChecksum, action: 'collect_sources' },
    { artifactId: snapshotId, revision: 1, kind: 'source_snapshot', mediaType: 'text/plain', checksum: inputChecksum, action: 'collect_sources', sourceId: evidence.sources[0]!.sourceId },
  ];

  const context = await resolver.notebook(input('create_content', dependencies, {
    title: 'Focus',
    sourceUrls: [rejectedBriefUrl],
    generationPlan,
  }));

  assert.deepEqual(context.sourceUrls, [acceptedUrl]);
  assert.deepEqual(context.evidence, evidence);
  assert.deepEqual(context.generationPlan, generationPlan);
});

test('passes a validated generation plan to NotebookLM, editorial QA, and media contexts', async () => {
  const researchId = '88888888-8888-4888-8888-888888888881';
  const createId = '88888888-8888-4888-8888-888888888882';
  const checkId = '88888888-8888-4888-8888-888888888883';
  const storyCandidate = await semanticCandidate();
  const client = contextClient(new Map([
    [researchId, Buffer.from(JSON.stringify({ acceptedSources: [{
      sourceId: evidence.sources[0]!.sourceId,
      title: evidence.sources[0]!.title,
      url: 'https://accepted.example.test/evidence',
    }] }))],
    [createId, Buffer.from(JSON.stringify(storyCandidate))],
    [checkId, Buffer.from(JSON.stringify({
      deterministic: { passed: true, contentChecksum: calculateContentChecksum(storyCandidate), findings: [] },
      editorial: {
        summary: 'Review this claim before publishing.',
        findings: [{
          code: 'unsupported-claim',
          severity: 'major',
          blocking: true,
          message: 'The claim needs a stronger source.',
        }],
      },
    }))],
  ]));
  const resolver = new LeaseScopedJobContextResolver(client, acceptingRecipeVerifier());
  const dependencies = [
    { artifactId: researchId, revision: 1, kind: 'parsed_output', mediaType: 'application/json', checksum: inputChecksum, action: 'collect_sources' },
    { artifactId: evidence.sources[0]!.snapshotArtifactId, revision: 1, kind: 'source_snapshot', mediaType: 'text/plain', checksum: inputChecksum, action: 'collect_sources', sourceId: evidence.sources[0]!.sourceId },
    { artifactId: createId, revision: 1, kind: 'parsed_output', mediaType: 'application/json', checksum: inputChecksum, action: 'create_content' },
    { artifactId: checkId, revision: 1, kind: 'parsed_output', mediaType: 'application/json', checksum: inputChecksum, action: 'check_content' },
  ];
  const brief = {
    title: 'Focus',
    locale: 'en-GB',
    audience: 'busy knowledge workers',
    objective: 'make interrupted work easier to resume',
    centralIdea: 'A visible next step reduces restart friction.',
    generationPlan,
  };

  const notebook = await resolver.notebook(input('create_content', dependencies, brief));
  const pi = await resolver.pi(input('check_content', dependencies, brief));
  const media = await resolver.media(input('produce_assets', dependencies, brief));

  assert.deepEqual(notebook.generationPlan, generationPlan);
  assert.deepEqual(pi.generationPlan, generationPlan);
  assert.deepEqual(media.generationPlan, generationPlan);
  assert.equal(notebook.locale, 'en-GB');
  assert.equal(notebook.audience, 'busy knowledge workers');
  assert.equal(notebook.objective, 'make interrupted work easier to resume');
  assert.equal(notebook.centralIdea, 'A visible next step reduces restart friction.');
  assert.deepEqual(pi.candidate, storyCandidate);
  assert.equal(media.passedCheck, true);
  assert.equal(media.contentChecksum, calculateContentChecksum(storyCandidate));
  assert.equal(notebook.resolvedRecipes?.story?.id, generationPlan.recipes.story.id);
  assert.equal(pi.resolvedRecipes?.editorialQa?.id, generationPlan.recipes.editorialQa.id);
  assert.equal(media.resolvedRecipes?.hero?.id, generationPlan.recipes.hero.id);
});

test('passes warning-bearing Story and Playbook QA through the media provider gate', async () => {
  const researchId = '99999999-9999-4999-8999-999999999991';
  const createId = '99999999-9999-4999-8999-999999999992';
  const checkId = '99999999-9999-4999-8999-999999999993';
  const storyCandidate = await semanticCandidate();
  const client = contextClient(new Map([
    [researchId, Buffer.from(JSON.stringify({ acceptedSources: [{
      sourceId: evidence.sources[0]!.sourceId,
      title: evidence.sources[0]!.title,
      url: 'https://accepted.example.test/evidence',
    }] }))],
    [createId, Buffer.from(JSON.stringify(storyCandidate))],
    [checkId, Buffer.from(JSON.stringify({
      deterministic: { passed: true, contentChecksum: calculateContentChecksum(storyCandidate), findings: [] },
      editorial: {
        summary: 'Review this claim before publishing.',
        findings: [{
          code: 'unsupported-claim',
          severity: 'major',
          blocking: true,
          message: 'The claim needs a stronger source.',
        }],
      },
    }))],
  ]));
  const resolver = new LeaseScopedJobContextResolver(client, acceptingRecipeVerifier());
  const dependencies = [
    { artifactId: researchId, revision: 1, kind: 'parsed_output', mediaType: 'application/json', checksum: inputChecksum, action: 'collect_sources' },
    { artifactId: evidence.sources[0]!.snapshotArtifactId, revision: 1, kind: 'source_snapshot', mediaType: 'application/json', checksum: inputChecksum, action: 'collect_sources', sourceId: evidence.sources[0]!.sourceId },
    { artifactId: createId, revision: 1, kind: 'parsed_output', mediaType: 'application/json', checksum: inputChecksum, action: 'create_content' },
    { artifactId: checkId, revision: 1, kind: 'parsed_output', mediaType: 'application/json', checksum: inputChecksum, action: 'check_content' },
  ];
  let mediaCalls = 0;
  const providers = composeWorkerProviders({
    env: {},
    runtime: {
      recipeBindingVerifier: acceptingRecipeVerifier(),
      mediaClient: {
        async generate() {
          mediaCalls += 1;
          return [];
        },
      },
      mediaContext: (execution) => resolver.media(execution),
    },
  });
  const media = providers[2];
  assert.ok(media);
  const brief = {
    title: 'Focus',
    locale: 'en-GB',
    audience: 'busy knowledge workers',
    objective: 'make interrupted work easier to resume',
    centralIdea: 'A visible next step reduces restart friction.',
    generationPlan,
  };

  await assert.rejects(
    () => media.execute(input('produce_assets', dependencies, brief)),
    /media_empty_response/,
  );
  assert.equal(mediaCalls, 1);
});

test('rejects missing or invalid Nuglet generation plans before reading provider dependencies', async () => {
  let artifactReads = 0;
  const client = contextClient(new Map());
  client.readArtifact = async () => {
    artifactReads += 1;
    throw new Error('provider dependency should not be read');
  };
  const resolver = new LeaseScopedJobContextResolver(client, acceptingRecipeVerifier());

  await assert.rejects(
    () => resolver.notebook(input('collect_sources', [], { title: 'Focus', contentKind: 'nuglet.lesson.v1' })),
    /generation_plan_missing/,
  );

  const missingChecksum = structuredClone(generationPlan);
  delete (missingChecksum.recipes.hero as { checksum?: string }).checksum;
  await assert.rejects(
    () => resolver.media(input('produce_assets', [], { title: 'Focus', generationPlan: missingChecksum })),
    /generation_plan_invalid/,
  );

  const mismatched = structuredClone(generationPlan);
  mismatched.recipes.hero.checksum = `sha256:${'b'.repeat(64)}`;
  const rejectingResolver = new LeaseScopedJobContextResolver(client, exactRecipeVerifier(generationPlan));
  await assert.rejects(
    () => rejectingResolver.pi(input('check_content', [], { title: 'Focus', generationPlan: mismatched })),
    /generation_recipe_binding_mismatch/,
  );
  assert.equal(artifactReads, 0);
});

test('fails closed without a trusted recipe verifier before reading dependencies', async () => {
  let artifactReads = 0;
  const client = contextClient(new Map());
  client.readArtifact = async () => {
    artifactReads += 1;
    throw new Error('provider dependency should not be read');
  };
  const resolver = new LeaseScopedJobContextResolver(client);

  await assert.rejects(
    () => resolver.notebook(input('collect_sources', [], { title: 'Focus', generationPlan })),
    /generation_recipe_verifier_unconfigured/,
  );
  assert.equal(artifactReads, 0);
});

test('invalid or untrusted Nuglet plans make zero NotebookLM, editorial, and media calls', async () => {
  const externalCalls = { notebooklm: 0, pi: 0, media: 0 };
  const verifier = exactRecipeVerifier(generationPlan);
  const runtime: ProviderRuntime = {
    recipeBindingVerifier: verifier,
    notebookProcess: {
      async run() {
        externalCalls.notebooklm += 1;
        throw new Error('NotebookLM must not run');
      },
    },
    notebookContext: async () => ({ notebookId: 'notebook-1', sourceUrls: [], topic: 'Focus' }),
    sourceVerifier: {
      async verify() { throw new Error('source verifier must not run'); },
    },
    piClient: {
      async check() {
        externalCalls.pi += 1;
        throw new Error('Pi must not run');
      },
    },
    piContext: async () => ({ candidate, evidence, rubric: 'Check it.' }),
    mediaClient: {
      async generate() {
        externalCalls.media += 1;
        throw new Error('media must not run');
      },
    },
    mediaContext: async () => ({ passedCheck: true, content: candidate, contentChecksum: inputChecksum }),
  };
  const [notebook, pi, media] = composeWorkerProviders({ env: {}, runtime });
  assert.ok(notebook && pi && media);

  const mismatched = structuredClone(generationPlan);
  mismatched.recipes.hero.checksum = `sha256:${'b'.repeat(64)}`;
  const badBrief = { title: 'Focus', generationPlan: mismatched };
  await assert.rejects(() => notebook.execute(input('collect_sources', [], badBrief)), /generation_recipe_binding_mismatch/);
  await assert.rejects(() => pi.execute(input('check_content', [], badBrief)), /generation_recipe_binding_mismatch/);
  await assert.rejects(() => media.execute(input('produce_assets', [], badBrief)), /generation_recipe_binding_mismatch/);

  const missingBrief = { title: 'Focus', contentKind: 'nuglet.lesson.v1' };
  await assert.rejects(() => notebook.execute(input('collect_sources', [], missingBrief)), /generation_plan_missing/);
  await assert.rejects(() => pi.execute(input('check_content', [], missingBrief)), /generation_plan_missing/);
  await assert.rejects(() => media.execute(input('produce_assets', [], missingBrief)), /generation_plan_missing/);

  const unverifiedRuntime = { ...runtime };
  delete unverifiedRuntime.recipeBindingVerifier;
  const [unverifiedNotebook, unverifiedPi, unverifiedMedia] = composeWorkerProviders({
    env: {},
    runtime: unverifiedRuntime,
  });
  assert.ok(unverifiedNotebook && unverifiedPi && unverifiedMedia);
  const validBrief = { title: 'Focus', generationPlan };
  await assert.rejects(
    () => unverifiedNotebook.execute(input('collect_sources', [], validBrief)),
    /generation_recipe_verifier_unconfigured/,
  );
  await assert.rejects(
    () => unverifiedPi.execute(input('check_content', [], validBrief)),
    /generation_recipe_verifier_unconfigured/,
  );
  await assert.rejects(
    () => unverifiedMedia.execute(input('produce_assets', [], validBrief)),
    /generation_recipe_verifier_unconfigured/,
  );

  assert.deepEqual(externalCalls, { notebooklm: 0, pi: 0, media: 0 });
});

test('mismatched Nuglet run and notebook identities make zero provider calls', async () => {
  const externalCalls = { notebooklm: 0, pi: 0, media: 0 };
  const runtime: ProviderRuntime = {
    recipeBindingVerifier: exactRecipeVerifier(generationPlan),
    notebookProcess: {
      async run() {
        externalCalls.notebooklm += 1;
        throw new Error('NotebookLM must not run');
      },
    },
    notebookContext: async () => ({ notebookId: 'notebook-fixture', sourceUrls: [], topic: 'Focus' }),
    sourceVerifier: { async verify() { throw new Error('source verifier must not run'); } },
    piClient: {
      async check() {
        externalCalls.pi += 1;
        throw new Error('Pi must not run');
      },
    },
    piContext: async () => ({ candidate, evidence, rubric: 'Check it.' }),
    mediaClient: {
      async generate() {
        externalCalls.media += 1;
        throw new Error('media must not run');
      },
    },
    mediaContext: async () => ({ passedCheck: true, content: candidate, contentChecksum: inputChecksum }),
  };
  const [notebook, pi, media] = composeWorkerProviders({ env: {}, runtime });
  assert.ok(notebook && pi && media);

  const wrongRun = nugletBrief();
  wrongRun.baseline.runId = 'another-run';
  await assert.rejects(() => notebook.execute(input('collect_sources', [], wrongRun)), /run_brief_invalid/);

  const wrongBriefNotebook = nugletBrief();
  wrongBriefNotebook.notebookLmNotebookId = 'another-notebook';
  await assert.rejects(() => pi.execute(input('check_content', [], wrongBriefNotebook)), /run_brief_invalid/);

  const wrongRunNotebook = input('produce_assets', [], nugletBrief());
  (wrongRunNotebook.job.input as { notebookLmNotebookId: string }).notebookLmNotebookId = 'another-notebook';
  await assert.rejects(() => media.execute(wrongRunNotebook), /run_notebook_id_mismatch/);

  assert.deepEqual(externalCalls, { notebooklm: 0, pi: 0, media: 0 });
});

test('executes editorial inference through the local Pi SDK adapter with an abort signal', async () => {
  let observed: Record<string, unknown> | undefined;
  const client = new LocalPiSdkClient({
    provider: 'fixture-provider',
    model: 'fixture-model',
    models: {
      async complete(request) {
        observed = request as unknown as Record<string, unknown>;
        return '```json\n{"summary":"Ready.","findings":[]}\n```';
      },
    },
  });
  const signal = new AbortController().signal;
  const result = await client.check({
    candidate,
    evidence,
    rubric: 'Check it.',
    renderedPrompt: 'Rendered editorial prompt.',
    idempotencyKey: 'stable-key',
    signal,
  });

  assert.deepEqual(result, { summary: 'Ready.', findings: [] });
  assert.equal(observed?.sessionId, 'stable-key');
  assert.equal(observed?.userPrompt, 'Rendered editorial prompt.');
  assert.ok(observed?.signal instanceof AbortSignal);
});

test('executes media generation through one bounded local command adapter', async () => {
  let commandInput: Record<string, unknown> | undefined;
  const recipes = resolvedRecipesFor(generationPlan);
  const client = new LocalMediaCommandClient({
    command: 'media-provider',
    process: {
      async run(input) {
        commandInput = input as unknown as Record<string, unknown>;
        return {
          stdout: JSON.stringify({
            assets: [{
              kind: 'hero',
              mediaType: 'image/webp',
              bytesBase64: Buffer.from('hero').toString('base64'),
              generationInputChecksum: inputChecksum,
              metadata: { byteSize: 4, height: 768, width: 1024 },
              support: {
                executions: [{
                  model: 'vertex:fixture-image',
                  promptBase64: Buffer.from('Rendered hero prompt.').toString('base64'),
                  promptChecksum: `sha256:${createHash('sha256').update('Rendered hero prompt.').digest('hex')}`,
                  provider: 'vertex',
                  recipe: generationPlan.recipes.hero,
                  referenceChecksums: [],
                }],
              },
            }],
          }),
          stderr: '',
          exitCode: 0,
        };
      },
    },
  });
  const result = await client.generate({
    content: candidate,
    generationInputChecksum: inputChecksum,
    kinds: ['hero'],
    idempotencyKey: 'stable-media-key',
    heroDirection: generationPlan.heroDirection,
    mediaBaseline: generationPlan.mediaBaseline,
    resolvedRecipes: recipes,
    executionInput: input('produce_assets', [], { generationPlan }),
    signal: new AbortController().signal,
  });

  assert.equal(Buffer.from(result[0]!.bytes).toString(), 'hero');
  assert.equal(
    Buffer.from(result[0]!.supportArtifacts[1]!.body).toString(),
    'Rendered hero prompt.',
  );
  assert.match(String(commandInput?.stdin), /stable-media-key/);
  assert.match(String(commandInput?.stdin), /canonicalBase64/);
  assert.match(String(commandInput?.stdin), /Move from distraction to focus/);
  assert.match(String(commandInput?.stdin), /media-baseline\.v1\.json/);
  assert.match(String(commandInput?.stdin), /fixture-run/);
  assert.equal(commandInput?.timeoutMs, 600_000);
});

test('force-kills a local provider process that ignores graceful timeout termination', { timeout: 3_000 }, async () => {
  const startedAt = Date.now();
  const result = await runProcess({
    command: process.execPath,
    args: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    timeoutMs: 100,
    signal: new AbortController().signal,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.ok(Date.now() - startedAt < 2_500);
});

const inputChecksum = 'a'.repeat(64);
const generationPlan = {
  contentKind: 'nuglet.lesson.v1' as const,
  schemaVersion: '1.1.0' as const,
  recipes: {
    story: { id: 'nuglet.lesson.story', version: '1.0.0', checksum: `sha256:${inputChecksum}` },
    playbook: { id: 'nuglet.lesson.playbook', version: '1.0.0', checksum: `sha256:${inputChecksum}` },
    challenge: { id: 'nuglet.challenge', version: '1.0.0', checksum: `sha256:${inputChecksum}` },
    infographic: { id: 'nuglet.visual.infographic', version: '1.0.0', checksum: `sha256:${inputChecksum}` },
    audioBrief: { id: 'nuglet.audio.brief', version: '1.0.0', checksum: `sha256:${inputChecksum}` },
    audioDiscussion: { id: 'nuglet.audio.discussion', version: '1.0.0', checksum: `sha256:${inputChecksum}` },
    hero: { id: 'nuglet.hero', version: '1.0.0', checksum: `sha256:${inputChecksum}` },
    editorialQa: { id: 'nuglet.qa.editorial', version: '1.0.0', checksum: `sha256:${inputChecksum}` },
  },
  heroDirection: {
    concept: 'Move from distraction to focus',
    metaphor: 'One stone settling beside a clear path',
    compositionFamily: 'asymmetrical-story' as const,
    mustInclude: ['one focal object'],
    mustAvoid: ['rigid symmetry'],
  },
  mediaBaseline: {
    descriptorChecksum: `sha256:${'f'.repeat(64)}`,
    descriptorPath: 'knowledge-bits/media-baseline.v1.json',
    descriptor: {
      artifacts: {
        infographic: baselineArtifact('nuglet.visual.infographic', 'infographic-artifact', 'notebooklm/infographic.webp'),
        audioBrief: baselineArtifact('nuglet.audio.brief', 'brief-artifact', 'audio/notebooklm-short-brief.m4a'),
        audioDiscussion: baselineArtifact('nuglet.audio.discussion', 'discussion-artifact', 'audio/notebooklm-medium-debate.m4a'),
      },
      notebookId: 'notebook-fixture',
      runFolder: 'apps/nuglet-lab/outputs/fixture-run',
      runId: 'fixture-run',
      schemaVersion: 'nuglet.media-baseline.v1',
    },
  } as const,
};

function baselineArtifact<Path extends string>(recipeId: string, artifactId: string, path: Path) {
  const prompt = Buffer.from(`Generate ${artifactId}`);
  return {
    checksum: `sha256:${(
      artifactId === 'brief-artifact' ? 'b' : artifactId === 'discussion-artifact' ? 'c' : 'd'
    ).repeat(64)}`,
    generation: {
      artifactId,
      model: 'notebooklm-cli:fixture',
      notebookId: 'notebook-fixture',
      prompt: {
        bytesBase64: prompt.toString('base64'),
        checksum: `sha256:${createHash('sha256').update(prompt).digest('hex')}`,
      },
      provider: 'notebooklm' as const,
      recipe: { id: recipeId, version: '1.0.0', checksum: `sha256:${inputChecksum}` },
    },
    mediaType: recipeId.includes('audio') ? 'audio/mp4' : 'image/webp',
    path,
    providerArtifactId: artifactId,
  };
}
const evidence = {
  sources: [{
    sourceId: '11111111-1111-4111-8111-111111111111',
    title: 'Evidence',
    snapshotArtifactId: '22222222-2222-4222-8222-222222222222',
  }],
};
const claimId = '55555555-5555-4555-8555-555555555555';
const candidate = {
  title: 'Return to one task',
  takeaway: 'A written next step makes returning easier.',
  action: 'Write one next task and work on it for five minutes.',
  depths: {
    quick: 'Name the next step before switching tasks.',
    core: 'Choose the task that matters now, then define the next visible step.',
    deep: 'Restart friction often comes from deciding what to do again.',
  },
  claims: [{
    claimId,
    statement: 'A concrete next step reduces restart friction.',
    citations: [{
      sourceId: evidence.sources[0]!.sourceId,
      snapshotArtifactId: evidence.sources[0]!.snapshotArtifactId,
      excerpt: 'A defined next action lowers restart friction.',
    }],
  }],
  claimCoverage: [
    { path: 'title' as const, claimIds: [claimId] },
    { path: 'takeaway' as const, claimIds: [claimId] },
    { path: 'action' as const, claimIds: [claimId] },
    { path: 'depths.quick' as const, claimIds: [claimId] },
    { path: 'depths.core' as const, claimIds: [claimId] },
    { path: 'depths.deep' as const, claimIds: [claimId] },
  ],
};

function input(
  action: 'collect_sources' | 'create_content' | 'check_content' | 'produce_assets',
  dependencies: unknown[] = [],
  brief: Record<string, unknown> = { title: 'Focus' },
) {
  const validatedBrief = compatibleRunBrief(brief);
  return {
    action,
    idempotencyKey: 'runtime-test',
    job: {
      jobId: '33333333-3333-4333-8333-333333333333',
      packageId: '44444444-4444-4444-8444-444444444444',
      stage: action === 'collect_sources' ? 'research' : action === 'create_content' ? 'create' : action === 'check_content' ? 'check' : 'produce_assets',
      claimedBy: 'runtime-test-worker',
      claimedAt: '2026-07-13T10:00:00.000Z',
      leaseExpiresAt: '2026-07-13T10:02:00.000Z',
      executionDeadlineAt: '2026-07-13T10:05:00.000Z',
      attempt: 1,
      revision: 1,
      input: {
        brief: validatedBrief,
        notebookLmNotebookId: typeof validatedBrief.notebookLmNotebookId === 'string'
          ? validatedBrief.notebookLmNotebookId
          : 'notebook-1',
        dependencies,
      },
    },
    signal: new AbortController().signal,
  } as const;
}

function compatibleRunBrief(brief: Record<string, unknown>): Record<string, unknown> {
  const plan = brief.generationPlan;
  if (!isTestRecord(plan) || plan.contentKind !== 'nuglet.lesson.v1') return brief;
  const mediaBaseline = plan.mediaBaseline;
  const descriptor = isTestRecord(mediaBaseline) && isTestRecord(mediaBaseline.descriptor)
    ? mediaBaseline.descriptor
    : undefined;
  return {
    ...(typeof descriptor?.runId === 'string' ? { baseline: { runId: descriptor.runId } } : {}),
    ...(typeof descriptor?.notebookId === 'string' ? { notebookLmNotebookId: descriptor.notebookId } : {}),
    ...brief,
  };
}

function isTestRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nugletBrief(): {
  title: string;
  baseline: { runId: string };
  generationPlan: typeof generationPlan;
  notebookLmNotebookId: string;
} {
  return {
    title: 'Focus',
    baseline: { runId: generationPlan.mediaBaseline.descriptor.runId },
    generationPlan,
    notebookLmNotebookId: generationPlan.mediaBaseline.descriptor.notebookId,
  };
}

function contextClient(bodies: Map<string, Uint8Array>): WorkerEngineClient {
  return {
    async claim() { return null; },
    async heartbeat() { return { kind: 'continue' }; },
    async readArtifact(_job, artifactId) {
      const body = bodies.get(artifactId);
      if (!body) throw new Error(`missing ${artifactId}`);
      return { body, mediaType: 'application/json' };
    },
    async prepareArtifact() { throw new Error('not used'); },
    async uploadArtifact() { throw new Error('not used'); },
    async completeArtifact() { throw new Error('not used'); },
    async reportResult() { throw new Error('not used'); },
    async runDelivery() { throw new Error('not used'); },
  };
}

function acceptingRecipeVerifier(): TrustedRecipeBindingVerifier {
  return { resolvePlan: (plan) => resolvedRecipesFor(plan) };
}

function exactRecipeVerifier(trusted: typeof generationPlan): TrustedRecipeBindingVerifier {
  return {
    resolvePlan() {
      return resolvedRecipesFor(trusted);
    },
  };
}

function resolvedRecipesFor(plan: Pick<NugletGenerationPlan, 'recipes'>) {
  return Object.fromEntries(Object.entries(plan.recipes).map(([role, binding]) => [role, {
    ...binding,
    canonicalBytes: Buffer.from(JSON.stringify(binding)),
    value: binding,
  }])) as unknown as ResolvedNugletRecipes;
}

async function semanticCandidate() {
  const fixture = JSON.parse(await readFile(
    new URL('./providers/fixtures/notebooklm-story-playbook.json', import.meta.url),
    'utf8',
  )) as { answer: { payload: { claims: Array<{ citations: Array<Record<string, unknown>> }> } } };
  const value = structuredClone(fixture.answer);
  for (const claim of value.payload.claims) {
    claim.citations = claim.citations.map((citation) => ({
      ...citation,
      snapshotArtifactId: evidence.sources[0]!.snapshotArtifactId,
    }));
  }
  return value;
}
