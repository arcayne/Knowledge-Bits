import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { NotebookLmProvider, type NotebookLmProcess } from './notebooklm.js';
import type { ProviderExecutionInput } from './types.js';
import { canonicalJsonBytes } from '../recipes/file-registry.js';
import { storyPlaybookDraftContractDescriptor } from '@knowledge-bits/contracts';

const sourceId = '11111111-1111-4111-8111-111111111111';

test('NotebookLM fixtures contain no credential names or absolute home paths', async () => {
  const fixtureUrls = [
    new URL('./fixtures/notebooklm-research.json', import.meta.url),
    new URL('./fixtures/notebooklm-create.json', import.meta.url),
    new URL('./fixtures/notebooklm-story-playbook.json', import.meta.url),
    new URL('./fixtures/pi-editorial.json', import.meta.url),
  ];
  const fixtures = await Promise.all(fixtureUrls.map(async (url) => JSON.parse(await readFile(url, 'utf8'))));
  const forbidden = /(?:api[_-]?key|authorization|bearer|cookie|password|secret|session|token|\/Users\/|\/home\/|[A-Z]:\\Users\\)/i;

  for (const fixture of fixtures) {
    assert.equal(forbidden.test(JSON.stringify(fixture)), false);
    assert.equal(forbidden.test(JSON.stringify(keysOf(fixture))), false);
  }
});

test('discovers the exact NotebookLM CLI version and records prompt provenance', async () => {
  const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
  const provider = new NotebookLmProvider({
    sourceVerifier: fakeSourceVerifier,
    process: processWith(calls, [
      { stdout: 'nlm 0.9.4\n', stderr: '', exitCode: 0 },
      { stdout: await fixture('notebooklm-research.json'), stderr: '', exitCode: 0 },
    ]),
    context: async () => ({
      notebookId: 'notebook_fixture_01',
      sourceUrls: [],
      topic: 'returning to focused work',
    }),
  });

  const result = await provider.execute(input('collect_sources'));

  assert.equal(result.kind, 'success');
  if (result.kind !== 'success') return;
  const report = result.executionReport as { cliVersion: string; promptVersion: string; renderedPrompt: string };
  assert.deepEqual(calls[0]?.args, ['--version']);
  assert.equal(report.cliVersion, 'nlm 0.9.4');
  assert.equal(report.promptVersion, 'notebooklm-research.v1');
  assert.match(report.renderedPrompt, /returning to focused work/);
  const output = result.parsedOutput as { acceptedSources: Array<{ sourceId: string }> };
  assert.equal(output.acceptedSources[0]?.sourceId, sourceId);
  assert.equal(result.assets?.[0]?.kind, 'source_snapshot');
});

test('does not activate Story recipe semantics before the Story and Playbook task', async () => {
  const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
  const storyRecipe = resolvedRecipe('nuglet.lesson.story', {
    id: 'nuglet.lesson.story',
    version: '1.0.0',
    status: 'approved',
    instructions: ['Keep the research grounded.'],
  });
  const provider = new NotebookLmProvider({
    sourceVerifier: fakeSourceVerifier,
    process: processWith(calls, [
      { stdout: 'nlm 0.9.4\n', stderr: '', exitCode: 0 },
      { stdout: await fixture('notebooklm-research.json'), stderr: '', exitCode: 0 },
    ]),
    context: async () => ({
      notebookId: 'notebook_fixture_01',
      sourceUrls: [],
      topic: 'returning to focused work',
      generationPlan: generationPlanFor({ story: storyRecipe }),
      resolvedRecipes: { story: storyRecipe },
    }),
  });

  const result = await provider.execute(input('collect_sources'));

  assert.equal(result.kind, 'success');
  if (result.kind !== 'success') return;
  assert.equal(calls.length, 2);
  const prompt = String(calls[1]?.args[3]);
  assert.doesNotMatch(prompt, /Keep the research grounded/);
  assert.equal(result.supportArtifacts, undefined);
});

test('creates a 1.1.0 semantic Story and Playbook draft from resolved recipes', async () => {
  const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
  const recipes = generationRecipes();
  const provider = new NotebookLmProvider({
    sourceVerifier: fakeSourceVerifier,
    process: processWith(calls, [
      { stdout: 'nlm 0.9.4\n', stderr: '', exitCode: 0 },
      { stdout: await fixture('notebooklm-story-playbook.json'), stderr: '', exitCode: 0 },
    ]),
    context: async () => ({
      notebookId: 'notebook_fixture_01',
      sourceUrls: [],
      topic: 'returning to focused work',
      locale: 'en-GB',
      audience: 'busy knowledge workers',
      objective: 'make interrupted work easier to resume',
      centralIdea: 'A visible next step reduces restart friction.',
      evidence: {
        sources: [{
          sourceId,
          title: 'Accepted source',
          snapshotArtifactId: '55555555-5555-4555-8555-555555555555',
        }],
      },
      generationPlan: generationPlanFor(recipes),
      resolvedRecipes: recipes,
    }),
  });

  const result = await provider.execute(input('create_content'));

  assert.equal(result.kind, 'success');
  if (result.kind !== 'success') return;
  assert.equal(calls.length, 2);
  const prompt = String(calls[1]?.args[3]);
  assert.match(prompt, /Open with one concrete interruption/);
  assert.match(prompt, /Give the learner three usable steps/);
  assert.match(prompt, /Return exactly three application questions/);
  assert.match(prompt, /"acceptedSourceIds":\s*\[\s*"11111111-1111-4111-8111-111111111111"/);
  assert.match(prompt, /"audience": "busy knowledge workers"/);
  assert.match(prompt, new RegExp(escapeRegExp(JSON.stringify(storyPlaybookDraftContractDescriptor, null, 2))));
  assert.doesNotMatch(prompt, /Required payload shape:/);
  assert.doesNotMatch(prompt, /The Story must contain/);
  assert.doesNotMatch(prompt, /Approved hero direction/);
  assert.doesNotMatch(prompt, /A clear path|One marked step/);
  assert.doesNotMatch(prompt, /depths\.quick/);

  const output = result.parsedOutput as {
    kind: string;
    schemaVersion: string;
    payload: {
      materialization: string;
      learning: { centralIdea: string; oneLineToKeep: string; action: { instruction: string } };
      read: {
        story: { blocks: Array<{ type: string; claimRefs: string[] }> };
        playbook: { principle: string; steps: unknown[]; example: unknown; watchOuts: string[]; action: string };
      };
      quiz: { questions: unknown[] };
      claims: Array<{ citations: Array<{ snapshotArtifactId: string }> }>;
    };
  };
  assert.equal(output.kind, 'nuglet.lesson.v1');
  assert.equal(output.schemaVersion, '1.1.0');
  assert.equal(output.payload.materialization, 'draft');
  assert.deepEqual(output.payload.read.story.blocks.map(({ type }) => type), [
    'opening', 'evidence', 'turning_point', 'practical_bridge',
  ]);
  assert.ok(output.payload.read.story.blocks.find(({ type }) => type === 'evidence')?.claimRefs.length);
  assert.equal(output.payload.read.playbook.principle, output.payload.learning.centralIdea);
  assert.equal(output.payload.read.playbook.steps.length, 3);
  assert.ok(output.payload.read.playbook.example);
  assert.ok(output.payload.read.playbook.watchOuts.length);
  assert.equal(output.payload.read.playbook.action, output.payload.learning.action.instruction);
  assert.equal(output.payload.quiz.questions.length, 3);
  assert.equal(output.payload.claims[0]?.citations[0]?.snapshotArtifactId, '55555555-5555-4555-8555-555555555555');
  assert.equal(/"(?:asset|transcript)"/.test(JSON.stringify(output)), false);

  assert.deepEqual(result.supportArtifacts?.map(({ kind }) => kind), [
    'generation.recipe.snapshot', 'generation.prompt.rendered',
    'generation.recipe.snapshot', 'generation.prompt.rendered',
    'generation.recipe.snapshot', 'generation.prompt.rendered',
  ]);
  assert.deepEqual(result.supportArtifacts?.filter(({ kind }) => kind === 'generation.recipe.snapshot')
    .map(({ body }) => Buffer.from(body).toString('utf8')), [
    Buffer.from(recipes.story.canonicalBytes).toString('utf8'),
    Buffer.from(recipes.playbook.canonicalBytes).toString('utf8'),
    Buffer.from(recipes.challenge.canonicalBytes).toString('utf8'),
  ]);
  for (const artifact of result.supportArtifacts?.filter(({ kind }) => kind === 'generation.prompt.rendered') ?? []) {
    assert.equal(Buffer.from(artifact.body).toString('utf8'), prompt);
  }
  const report = result.executionReport as { promptVersion: string; renderedPrompt: string; renderedPrompts: string[] };
  assert.equal(report.promptVersion, 'notebooklm-recipe-create.v1');
  assert.equal(report.renderedPrompt, prompt);
  assert.deepEqual(report.renderedPrompts, [prompt]);
});

test('records every recipe-shaped NotebookLM repair call with its exact prompt', async () => {
  const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
  const recipes = generationRecipes();
  const provider = new NotebookLmProvider({
    sourceVerifier: fakeSourceVerifier,
    process: processWith(calls, [
      { stdout: 'nlm 0.9.4\n', stderr: '', exitCode: 0 },
      { stdout: 'not json', stderr: '', exitCode: 0 },
      { stdout: await fixture('notebooklm-story-playbook.json'), stderr: '', exitCode: 0 },
    ]),
    context: async () => ({
      notebookId: 'notebook_fixture_01',
      sourceUrls: [],
      topic: 'returning to focused work',
      locale: 'en-GB',
      audience: 'busy knowledge workers',
      objective: 'make interrupted work easier to resume',
      evidence: {
        sources: [{
          sourceId,
          title: 'Accepted source',
          snapshotArtifactId: '55555555-5555-4555-8555-555555555555',
        }],
      },
      generationPlan: generationPlanFor(recipes),
      resolvedRecipes: recipes,
    }),
  });

  const result = await provider.execute(input('create_content'));

  assert.equal(result.kind, 'success');
  if (result.kind !== 'success') return;
  const prompts = [String(calls[1]?.args[3]), String(calls[2]?.args[3])];
  assert.match(prompts[1]!, /strict JSON object/);
  assert.equal(result.supportArtifacts?.length, 12);
  assert.deepEqual(
    result.supportArtifacts?.filter(({ kind }) => kind === 'generation.prompt.rendered')
      .map(({ body }) => Buffer.from(body).toString('utf8')),
    [prompts[0], prompts[0], prompts[0], prompts[1], prompts[1], prompts[1]],
  );
  assert.deepEqual(
    (result.executionReport as { renderedPrompts: string[] }).renderedPrompts,
    prompts,
  );
});

test('repairs a structurally invalid direct Story and Playbook answer once and records both prompts', async () => {
  const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
  const recipes = generationRecipes();
  const invalidAnswer = await directStoryPlaybookFailure();
  const provider = storyPlaybookProvider(calls, recipes, [
    { stdout: invalidAnswer, stderr: '', exitCode: 0 },
    { stdout: await fixture('notebooklm-story-playbook.json'), stderr: '', exitCode: 0 },
  ]);

  const result = await provider.execute(input('create_content'));

  assert.equal(result.kind, 'success');
  if (result.kind !== 'success') return;
  assert.equal(calls.length, 3);
  const [originalPrompt, repairPrompt] = [String(calls[1]?.args[3]), String(calls[2]?.args[3])];
  assert.equal(repairPrompt.startsWith(originalPrompt), true);
  assert.match(repairPrompt, /prior answer was structurally invalid/i);
  assert.match(repairPrompt, /\$\.kind: Expected "nuglet\.lesson\.v1"/);
  assert.match(repairPrompt, /\$\.schemaVersion: Expected "1\.1\.0"/);
  assert.match(repairPrompt, /\$\.payload\.contentModel: Invalid literal value, expected "story-playbook\.v1"\./);
  assert.match(repairPrompt, /"kind": "nuglet\.lesson\.v1"/);
  assert.match(repairPrompt, new RegExp(escapeRegExp(JSON.stringify(storyPlaybookDraftContractDescriptor, null, 2))));
  assert.match(repairPrompt, /preserve grounded meaning and accepted citations/i);
  assert.doesNotMatch(repairPrompt, /direct-unwrapped-story-playbook/);
  assert.doesNotMatch(repairPrompt, /source snapshot text/i);
  assert.deepEqual((result.executionReport as { renderedPrompts: string[] }).renderedPrompts, [originalPrompt, repairPrompt]);
  assert.equal(result.supportArtifacts?.length, 12);
  assert.deepEqual(
    result.supportArtifacts?.filter(({ kind }) => kind === 'generation.prompt.rendered')
      .map(({ body }) => Buffer.from(body).toString('utf8')),
    [originalPrompt, originalPrompt, originalPrompt, repairPrompt, repairPrompt, repairPrompt],
  );
  assert.equal(Buffer.from(result.rawResponse).toString('utf8'), await fixture('notebooklm-story-playbook.json'));
});

test('rejects a second structurally invalid Story and Playbook answer as a typed quality issue', async () => {
  const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
  const recipes = generationRecipes();
  const invalidAnswer = await directStoryPlaybookFailure();
  const provider = storyPlaybookProvider(calls, recipes, [
    { stdout: invalidAnswer, stderr: '', exitCode: 0 },
    { stdout: invalidAnswer, stderr: '', exitCode: 0 },
  ]);

  await assert.rejects(
    () => provider.execute(input('create_content')),
    (error: unknown) => error instanceof Error
      && error.message === 'notebooklm_content_invalid'
      && 'needsHumanKind' in error
      && error.needsHumanKind === 'quality',
  );
  assert.equal(calls.length, 3);
});

test('keeps accepted-source citation binding on a semantically repaired Story and Playbook answer', async () => {
  const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
  const recipes = generationRecipes();
  const repaired = JSON.parse(await fixture('notebooklm-story-playbook.json')) as { answer: { payload: { claims: Array<{ citations: Array<{ sourceId: string }> }> } } };
  repaired.answer.payload.claims[0]!.citations[0]!.sourceId = '22222222-2222-4222-8222-222222222222';
  const provider = storyPlaybookProvider(calls, recipes, [
    { stdout: await directStoryPlaybookFailure(), stderr: '', exitCode: 0 },
    { stdout: JSON.stringify(repaired), stderr: '', exitCode: 0 },
  ]);

  await assert.rejects(() => provider.execute(input('create_content')), /notebooklm_citation_source_missing/);
  assert.equal(calls.length, 3);
});

test('accepts the NotebookLM CLI snake_case envelope and verifies run sources when citations have no URLs', async () => {
  const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
  const sourceUrl = 'https://example.test/personal-finance';
  const provider = new NotebookLmProvider({
    sourceVerifier: fakeSourceVerifier,
    process: processWith(calls, [
      { stdout: 'nlm 0.9.4\n', stderr: '', exitCode: 0 },
      { stdout: '[]', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      {
        stdout: JSON.stringify({
          answer: JSON.stringify({
            topic: 'Personal Finance 101',
            source_candidates: [{ claim: 'A grounded claim', sourceId: [59], excerpts: ['Evidence'] }],
          }),
          conversation_id: 'conversation_snake_case',
        }),
        stderr: '',
        exitCode: 0,
      },
    ]),
    context: async () => ({
      notebookId: 'notebook_fixture_01',
      sourceUrls: [sourceUrl],
      topic: 'Personal Finance 101',
    }),
  });

  const result = await provider.execute(input('collect_sources'));

  assert.equal(result.kind, 'success');
  if (result.kind !== 'success') return;
  assert.equal((result.executionReport as { conversationId: string }).conversationId, 'conversation_snake_case');
  assert.equal(calls.length, 4);
});

test('does not re-import URLs that already exist in the NotebookLM notebook', async () => {
  const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
  const sourceUrl = 'https://example.test/already-imported';
  const provider = new NotebookLmProvider({
    sourceVerifier: fakeSourceVerifier,
    process: processWith(calls, [
      { stdout: 'nlm 0.9.4\n', stderr: '', exitCode: 0 },
      { stdout: JSON.stringify([{ url: sourceUrl }]), stderr: '', exitCode: 0 },
      { stdout: await fixture('notebooklm-research.json'), stderr: '', exitCode: 0 },
    ]),
    context: async () => ({
      notebookId: 'notebook_fixture_01',
      sourceUrls: [sourceUrl],
      topic: 'focus',
    }),
  });

  const result = await provider.execute(input('collect_sources'));

  assert.equal(result.kind, 'success');
  assert.equal(calls.length, 3);
  assert.equal(calls.some(({ args }) => args.includes('add')), false);
});

test('classifies a provider cooldown without attempting a structured repair', async () => {
  const provider = new NotebookLmProvider({
    sourceVerifier: fakeSourceVerifier,
    now: () => new Date('2026-07-13T10:00:00.000Z'),
    process: processWith([], [
      { stdout: 'nlm 0.9.4\n', stderr: '', exitCode: 0 },
      { stdout: '', stderr: 'rate limit, retry after 120 seconds', exitCode: 75 },
    ]),
    context: async () => ({ notebookId: 'notebook_fixture_01', sourceUrls: [], topic: 'focus' }),
  });

  await assert.rejects(
    () => provider.execute(input('collect_sources')),
    (error: unknown) => error instanceof Error && error.message === 'notebooklm_cooldown' && 'retryAt' in error
      && (error as { retryAt: string }).retryAt === '2026-07-13T10:02:00.000Z',
  );
});

test('uses exactly one repair request for malformed structured output', async () => {
  const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
  const provider = new NotebookLmProvider({
    sourceVerifier: fakeSourceVerifier,
    process: processWith(calls, [
      { stdout: 'nlm 0.9.4\n', stderr: '', exitCode: 0 },
      { stdout: 'not json', stderr: '', exitCode: 0 },
      { stdout: await fixture('notebooklm-research.json'), stderr: '', exitCode: 0 },
    ]),
    context: async () => ({ notebookId: 'notebook_fixture_01', sourceUrls: [], topic: 'focus' }),
  });

  const result = await provider.execute(input('collect_sources'));

  assert.equal(result.kind, 'success');
  assert.equal(calls.length, 3);
  assert.equal(calls[1]?.args.at(-1), '--json');
  assert.equal(calls[2]?.args.at(-1), '--json');
  assert.equal(calls[1]?.stdin, undefined);
  assert.match(String(calls[2]?.args[3]), /strict JSON object/);
});

test('rejects malformed structured output after its one repair attempt', async () => {
  const provider = new NotebookLmProvider({
    sourceVerifier: fakeSourceVerifier,
    process: processWith([], [
      { stdout: 'nlm 0.9.4\n', stderr: '', exitCode: 0 },
      { stdout: 'not json', stderr: '', exitCode: 0 },
      { stdout: 'still not json', stderr: '', exitCode: 0 },
    ]),
    context: async () => ({ notebookId: 'notebook_fixture_01', sourceUrls: [], topic: 'focus' }),
  });

  await assert.rejects(() => provider.execute(input('collect_sources')), /notebooklm_malformed_output/);
});

test('rejects citations that do not resolve to a returned source', async () => {
  const provider = new NotebookLmProvider({
    sourceVerifier: fakeSourceVerifier,
    process: processWith([], [
      { stdout: 'nlm 0.9.4\\n', stderr: '', exitCode: 0 },
      {
        stdout: JSON.stringify({
          conversationId: 'conversation_fixture_01',
          answer: { claims: [{ statement: 'A claim', citations: [{ sourceId: '22222222-2222-4222-8222-222222222222', excerpt: 'proof' }] }], sources: [] },
        }),
        stderr: '',
        exitCode: 0,
      },
      { stdout: 'still not json', stderr: '', exitCode: 0 },
    ]),
    context: async () => ({ notebookId: 'notebook_fixture_01', sourceUrls: [], topic: 'focus' }),
  });

  await assert.rejects(() => provider.execute(input('collect_sources')), /citation.*source/i);
});

test('classifies process timeouts as a typed wait', async () => {
  const timeoutProcess: NotebookLmProcess = {
    async run() {
      return { stdout: '', stderr: '', exitCode: null, timedOut: true };
    },
  };
  const provider = new NotebookLmProvider({
    sourceVerifier: fakeSourceVerifier,
    now: () => new Date('2026-07-13T10:00:00.000Z'),
    process: timeoutProcess,
    context: async () => ({ notebookId: 'notebook_fixture_01', sourceUrls: [], topic: 'focus' }),
  });
  await assert.rejects(() => provider.execute(input('collect_sources')), /notebooklm_timeout/);
});

test('allows a fourth revision because revision policy belongs to the state machine', async () => {
  const provider = new NotebookLmProvider({
    sourceVerifier: fakeSourceVerifier,
    process: processWith([], [
      { stdout: 'nlm 0.9.4\n', stderr: '', exitCode: 0 },
      { stdout: await fixture('notebooklm-create.json'), stderr: '', exitCode: 0 },
    ]),
    context: async () => ({
      notebookId: 'notebook_fixture_01',
      sourceUrls: [],
      topic: 'focus',
      evidence: { sources: [{ sourceId, title: 'Accepted source', snapshotArtifactId: '55555555-5555-4555-8555-555555555555' }] },
    }),
  });
  const result = await provider.execute(input('create_content', 4));

  assert.equal(result.kind, 'success');
  if (result.kind === 'success') {
    const output = result.parsedOutput as { claims: Array<{ citations: Array<{ snapshotArtifactId: string }> }> };
    assert.equal(output.claims[0]?.citations[0]?.snapshotArtifactId, '55555555-5555-4555-8555-555555555555');
  }
});

test('classifies incomplete learner claim coverage as a quality failure at Create', async () => {
  const provider = new NotebookLmProvider({
    sourceVerifier: fakeSourceVerifier,
    process: processWith([], [
      { stdout: 'nlm 0.9.4\n', stderr: '', exitCode: 0 },
      {
        stdout: JSON.stringify({
          conversationId: 'conversation_fixture_01',
          answer: {
            title: 'Incomplete lesson',
            takeaway: 'A takeaway.',
            action: 'An action.',
            depths: { quick: 'Quick.', core: 'Core.', deep: 'Deep.' },
            claims: [],
            claimCoverage: [],
          },
        }),
        stderr: '',
        exitCode: 0,
      },
    ]),
    context: async () => ({
      notebookId: 'notebook_fixture_01',
      sourceUrls: [],
      topic: 'focus',
      evidence: { sources: [{ sourceId, title: 'Accepted source', snapshotArtifactId: '55555555-5555-4555-8555-555555555555' }] },
    }),
  });

  await assert.rejects(
    () => provider.execute(input('create_content')),
    (error: unknown) => error instanceof Error
      && error.message === 'notebooklm_content_invalid'
      && 'needsHumanKind' in error
      && error.needsHumanKind === 'quality',
  );
});

test('does not let a create response authorize citations with its recommended sources', async () => {
  const selfAuthorizedSource = '22222222-2222-4222-8222-222222222222';
  const provider = new NotebookLmProvider({
    sourceVerifier: fakeSourceVerifier,
    process: processWith([], [
      { stdout: 'nlm 0.9.4\n', stderr: '', exitCode: 0 },
      {
        stdout: JSON.stringify({
          conversationId: 'conversation_fixture_01',
          answer: {
            claims: [{ statement: 'An unsupported claim.', citations: [{ sourceId: selfAuthorizedSource, excerpt: 'Invented support.' }] }],
            sources: [{ sourceId: selfAuthorizedSource, title: 'Candidate source' }],
          },
        }),
        stderr: '',
        exitCode: 0,
      },
    ]),
    context: async () => ({
      notebookId: 'notebook_fixture_01',
      sourceUrls: [],
      topic: 'focus',
      evidence: { sources: [{ sourceId, title: 'Accepted source', snapshotArtifactId: '55555555-5555-4555-8555-555555555555' }] },
    }),
  });

  await assert.rejects(() => provider.execute(input('create_content')), /notebooklm_citation_source_missing/);
});

function input(action: ProviderExecutionInput['action'], revision = 1): ProviderExecutionInput {
  return {
    action,
    idempotencyKey: 'operation_fixture',
    job: {
      jobId: '33333333-3333-4333-8333-333333333333',
      packageId: '44444444-4444-4444-8444-444444444444',
      stage: action === 'collect_sources' ? 'research' : 'create',
      claimedBy: 'test-worker',
      claimedAt: '2026-07-13T10:00:00.000Z',
      leaseExpiresAt: '2026-07-13T10:02:00.000Z',
      executionDeadlineAt: '2026-07-13T10:05:00.000Z',
      attempt: 1,
      revision,
      input: { brief: {}, dependencies: [] },
    },
    signal: new AbortController().signal,
  };
}

function processWith(
  calls: Array<{ args: readonly string[]; stdin?: string }>,
  responses: Array<{ stdout: string; stderr: string; exitCode: number | null; timedOut?: boolean }>,
): NotebookLmProcess {
  return {
    async run(command) {
      calls.push({ args: command.args, stdin: command.stdin });
      const response = responses.shift();
      if (!response) throw new Error('Unexpected NotebookLM process invocation');
      return response;
    },
  };
}

function storyPlaybookProvider(
  calls: Array<{ args: readonly string[]; stdin?: string }>,
  recipes: ReturnType<typeof generationRecipes>,
  responses: Array<{ stdout: string; stderr: string; exitCode: number | null; timedOut?: boolean }>,
) {
  return new NotebookLmProvider({
    sourceVerifier: fakeSourceVerifier,
    process: processWith(calls, [
      { stdout: 'nlm 0.9.4\\n', stderr: '', exitCode: 0 },
      ...responses,
    ]),
    context: async () => ({
      notebookId: 'notebook_fixture_01',
      sourceUrls: [],
      topic: 'returning to focused work',
      locale: 'en-GB',
      audience: 'busy knowledge workers',
      objective: 'make interrupted work easier to resume',
      evidence: {
        sources: [{
          sourceId,
          title: 'Accepted source',
          snapshotArtifactId: '55555555-5555-4555-8555-555555555555',
        }],
      },
      generationPlan: generationPlanFor(recipes),
      resolvedRecipes: recipes,
    }),
  });
}

async function directStoryPlaybookFailure(): Promise<string> {
  const valid = JSON.parse(await fixture('notebooklm-story-playbook.json')) as { answer: { payload: Record<string, unknown> } };
  const payload = valid.answer.payload;
  return JSON.stringify({
    conversationId: 'direct-unwrapped-story-playbook',
    answer: {
      ...payload,
      claims: (payload.claims as Array<Record<string, unknown>>).map((claim) => ({
        ...claim,
        claimId: 'claim-one',
      })),
      read: {
        ...(payload.read as Record<string, unknown>),
        playbook: {
          ...((payload.read as { playbook: Record<string, unknown> }).playbook),
          watchOuts: 'Name the visible next step.',
        },
      },
      visual: {
        ...(payload.visual as Record<string, unknown>),
        textEquivalent: 'Choose, separate, repeat.',
      },
      hero: {
        ...(payload.hero as Record<string, unknown>),
        accessibilityPurpose: 'A useful visual explanation.',
      },
    },
  });
}

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...keysOf(child)]);
}

void sourceId;

const fakeSourceVerifier = {
  async verify(value: unknown) {
    const sources = (value as { sources: Array<{ sourceId: string; title: string; url: string }> }).sources;
    return {
      evidence: {
        acceptedSources: sources.map((source) => ({
          ...source,
          retrievedAt: '2026-07-13T10:00:00.000Z',
          snapshotChecksum: 'a'.repeat(64),
          readability: { passed: true, reason: null },
          credibility: { passed: true, policy: 'fixture-trusted-hosts.v1', reason: null },
        })),
        rejectedSources: [],
        coverageGaps: [],
      },
      snapshots: [{
        kind: 'source_snapshot',
        mediaType: 'text/plain',
        body: Buffer.from('fixture source snapshot'),
        inputChecksum: null,
        provenance: { sourceId: sources[0]?.sourceId },
      }],
    };
  },
};

function resolvedRecipe(id: string, value: Record<string, unknown>) {
  const canonicalBytes = canonicalJsonBytes(value);
  return {
    id,
    version: '1.0.0',
    checksum: `sha256:${createHash('sha256').update(canonicalBytes).digest('hex')}`,
    canonicalBytes,
    value,
  };
}

function generationRecipes() {
  return {
    story: resolvedRecipe('nuglet.lesson.story', {
      id: 'nuglet.lesson.story',
      version: '1.0.0',
      status: 'approved',
      instructions: ['Open with one concrete interruption.'],
    }),
    playbook: resolvedRecipe('nuglet.lesson.playbook', {
      id: 'nuglet.lesson.playbook',
      version: '1.0.0',
      status: 'approved',
      instructions: ['Give the learner three usable steps.'],
    }),
    challenge: resolvedRecipe('nuglet.challenge', {
      id: 'nuglet.challenge',
      version: '1.0.0',
      status: 'approved',
      instructions: ['Return exactly three application questions.'],
    }),
  };
}

function generationPlanFor(recipes: { story: ReturnType<typeof resolvedRecipe>; playbook?: ReturnType<typeof resolvedRecipe>; challenge?: ReturnType<typeof resolvedRecipe> }) {
  const binding = <Id extends string>(id: Id, recipe?: ReturnType<typeof resolvedRecipe>) => ({
    id,
    version: '1.0.0',
    checksum: recipe?.checksum ?? recipes.story.checksum,
  });
  const planRecipes = {
    story: { id: 'nuglet.lesson.story' as const, version: '1.0.0', checksum: recipes.story.checksum },
    playbook: binding('nuglet.lesson.playbook', recipes.playbook),
    challenge: binding('nuglet.challenge', recipes.challenge),
    infographic: binding('nuglet.visual.infographic'),
    audioBrief: binding('nuglet.audio.brief'),
    audioDiscussion: binding('nuglet.audio.discussion'),
    hero: binding('nuglet.hero'),
    editorialQa: binding('nuglet.qa.editorial'),
  };
  return {
    contentKind: 'nuglet.lesson.v1' as const,
    schemaVersion: '1.1.0' as const,
    recipes: planRecipes,
    heroDirection: {
      concept: 'A clear path',
      metaphor: 'One marked step',
      compositionFamily: 'asymmetrical-story' as const,
      mustInclude: ['one focal object'],
      mustAvoid: ['rigid symmetry'],
    },
    mediaBaseline: mediaBaselineFor(planRecipes),
  };
}

function mediaBaselineFor(recipes: Record<string, { id: string; version: string; checksum: string }>) {
  const artifact = <Path extends string>(
    role: 'infographic' | 'audioBrief' | 'audioDiscussion',
    artifactId: string,
    path: Path,
  ) => {
    const prompt = Buffer.from(`Generate ${artifactId}`);
    const recipe = recipes[role]!;
    return {
      checksum: `sha256:${(
        role === 'audioBrief' ? 'b' : role === 'audioDiscussion' ? 'c' : 'd'
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
        recipe: { id: recipe.id, version: recipe.version, checksum: recipe.checksum },
      },
      mediaType: role === 'infographic' ? 'image/webp' : 'audio/mp4',
      path,
      providerArtifactId: artifactId,
    };
  };
  return {
    descriptorChecksum: `sha256:${'f'.repeat(64)}`,
    descriptorPath: 'knowledge-bits/media-baseline.v1.json' as const,
    descriptor: {
      artifacts: {
        infographic: artifact('infographic', 'infographic-artifact', 'notebooklm/infographic.webp'),
        audioBrief: artifact('audioBrief', 'brief-artifact', 'audio/notebooklm-short-brief.m4a'),
        audioDiscussion: artifact('audioDiscussion', 'discussion-artifact', 'audio/notebooklm-medium-debate.m4a'),
      },
      notebookId: 'notebook-fixture',
      runFolder: 'apps/nuglet-lab/outputs/fixture-run',
      runId: 'fixture-run',
      schemaVersion: 'nuglet.media-baseline.v1' as const,
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
