import assert from 'node:assert/strict';
import test from 'node:test';

import type { NugletNarrativeGenerationPlan } from '@knowledge-bits/contracts';

import { runDeterministicChecks } from '../checks/deterministic.js';
import type { ResolvedRecipe } from '../recipes/types.js';
import { ContentCreationRouterProvider } from './content-creation-router.js';
import {
  NarrativeWriterProvider,
  parseNarrativeWriterResponse,
  renderNarrativeWriterPrompt,
  type NarrativeWriterContext,
  type NarrativeWriterSource,
} from './narrative-writer.js';
import type { ContentProvider, ProviderExecutionInput } from './types.js';
import { PiEditorialProvider } from './pi.js';

const claimId = '0f8fad5b-d9cb-469f-a165-708677289510';
const snapshotArtifactId = '0f8fad5b-d9cb-469f-a165-708677289512';
const evidenceExcerpt = 'Participants reported fewer intrusive thoughts after forming a specific plan.';

const source: NarrativeWriterSource = {
  sourceId: 'source-1',
  title: 'Study of unfinished goals',
  snapshotArtifactId,
  text: `The study followed knowledge workers for one week. ${evidenceExcerpt} The effect was strongest when the plan named a concrete next action.`,
};

function recipe(id: string): ResolvedRecipe {
  const instructions = id === 'nuglet.lesson.narrative'
    ? [
        'Write identity.deck as a spoken cold open that a listener can understand the first time she hears it.',
        'Read the deck and first scene sentence together and remove needless repetition.',
        'Do not use em dashes, en dashes, curly double quotation marks, or spaced double hyphens in authored learner copy.',
      ]
    : [`Instructions for ${id}`];
  const value = { id, version: '1.0.0', status: 'approved', instructions };
  return {
    id,
    version: '1.0.0',
    checksum: `sha256:${id === 'nuglet.lesson.narrative' ? 'a' : 'b'.repeat(64)}`.replace(/:a$/, `:${'a'.repeat(64)}`),
    canonicalBytes: Buffer.from(JSON.stringify(value)),
    value,
  };
}

function plan(): NugletNarrativeGenerationPlan {
  const binding = <Id extends string>(id: Id, digit: string) => ({
    id,
    version: '1.0.0' as const,
    checksum: `sha256:${digit.repeat(64)}`,
  });
  return {
    contentKind: 'nuglet.lesson.v2',
    schemaVersion: '2.0.0',
    recipes: {
      writer: binding('nuglet.lesson.narrative', '1'),
      challenge: binding('nuglet.challenge', '2'),
      infographic: binding('nuglet.visual.infographic', '3'),
      audioConversation: binding('nuglet.audio.conversation', '4'),
      hero: binding('nuglet.hero', '5'),
      editorialQa: binding('nuglet.qa.editorial', '6'),
    },
    heroDirection: {
      concept: 'One clear next step',
      metaphor: 'A loose thread tied into a knot',
      compositionFamily: 'asymmetrical-story',
      mustInclude: ['one focal action'],
      mustAvoid: ['generic icons'],
    },
    mediaMode: 'generate',
  };
}

function context(): NarrativeWriterContext {
  return {
    topic: 'Unfinished work thoughts',
    locale: 'en',
    audience: 'busy working women who are intelligent general readers',
    objective: 'Help readers close the mental loop after work.',
    generationPlan: plan(),
    recipes: {
      writer: recipe('nuglet.lesson.narrative'),
      challenge: recipe('nuglet.challenge'),
    },
    sources: [source],
  };
}

function candidate() {
  const claimRefs = [claimId];
  return {
    kind: 'nuglet.lesson.v2',
    schemaVersion: '2.0.0',
    payload: {
      contentModel: 'single-narrative.v2',
      materialization: 'draft',
      identity: {
        locale: 'en',
        topic: { label: 'Work and attention', categoryId: null },
        tags: ['attention'],
        title: 'The thought that followed you home',
        deck: 'Maya closed her laptop. She was still composing the unfinished email in her head.',
        slugSuggestion: 'the-thought-that-followed-you-home',
      },
      learning: {
        oneLineToKeep: 'A thought feels urgent when your mind has not seen a clear next step.',
        action: {
          label: 'Name the next visible step',
          instruction: 'Before you stop work, write the next action in one concrete sentence.',
        },
        terminology: [],
      },
      hero: {
        altText: 'A woman closes her laptop beside a note with one next step.',
        accessibilityPurpose: 'informative',
        mediaBrief: {
          concept: 'Closing the workday',
          metaphor: 'A loose thread tied into a small knot',
          compositionFamily: 'asymmetrical-story',
        },
      },
      read: {
        lesson: {
          title: 'The thought that followed you home',
          estimatedMinutes: 5,
          sections: [
            { id: 'scene', type: 'scene', text: 'Maya had closed her laptop, but the unfinished email was still composing itself in her head.', claimRefs: [] },
            { id: 'discovery', type: 'discovery', text: 'Her mind had no clear ending to hold on to.', claimRefs: [] },
            { id: 'evidence', type: 'evidence', text: 'A specific plan can reduce intrusive thoughts about unfinished goals.', claimRefs },
            { id: 'application', type: 'application', text: 'A concrete next action gives the thought somewhere to land.', claimRefs },
            { id: 'close', type: 'close', text: 'She wrote one sentence, shut the notebook, and the evening finally felt like hers.', claimRefs: [] },
          ],
        },
      },
      visual: {
        title: 'Give the thought somewhere to land',
        altText: 'An unfinished thought moves into one written next step.',
        textEquivalent: ['Unfinished thought', 'Name the next action', 'Return later'],
        claimRefs,
        mediaBrief: { objective: 'Show the shift from rumination to a concrete plan', structure: 'one before-and-after path' },
      },
      listen: {
        conversation: {
          editorialBrief: {
            objective: 'Explore why work thoughts follow us home and how a concrete next step can help.',
            tone: 'warm, curious, and natural',
            keyPoints: ['recognizable after-work moment', 'plain-language explanation', 'one practical action'],
            format: 'two-person-conversation',
          },
        },
      },
      quiz: {
        questions: Array.from({ length: 3 }, (_, index) => ({
          id: `q${index + 1}`,
          prompt: `Which response gives an unfinished task a clear next step ${index + 1}?`,
          options: [
            { id: 'a', text: 'Keep thinking about it' },
            { id: 'b', text: 'Write one concrete next action' },
            { id: 'c', text: 'Add it to a vague list' },
          ],
          correctOptionId: 'b',
          rationale: 'A concrete next action makes the future return point visible.',
          claimRefs,
        })),
      },
      publicSources: [{ evidenceSourceId: 'source-1', label: 'Study of unfinished goals', publisher: 'Example Journal' }],
      claims: [{
        claimId,
        statement: 'A specific plan can reduce intrusive thoughts about unfinished goals.',
        citations: [{ sourceId: 'source-1', excerpt: evidenceExcerpt }],
      }],
      claimCoverage: [
        { path: 'read.lesson', claimIds: claimRefs },
        { path: 'visual', claimIds: claimRefs },
        { path: 'listen.conversation', claimIds: claimRefs },
        { path: 'quiz', claimIds: claimRefs },
      ],
    },
  };
}

function executionInput(contentKind = 'nuglet.lesson.v2'): ProviderExecutionInput {
  return {
    action: 'create_content',
    idempotencyKey: 'writer:test',
    signal: new AbortController().signal,
    job: {
      input: {
        brief: {
          contentKind,
          generationPlan: { contentKind },
        },
        dependencies: [],
      },
    },
  } as unknown as ProviderExecutionInput;
}

test('writer prompt makes the single narrative boundary and evidence inputs explicit', () => {
  const prompt = Buffer.from(renderNarrativeWriterPrompt(context())).toString('utf8');
  assert.match(prompt, /writtenLessonCount/);
  assert.match(prompt, /Exact response skeleton/);
  assert.match(prompt, /Return exactly the top-level keys kind, schemaVersion, and payload/);
  assert.match(prompt, /\"materialization\":\"draft\"/);
  assert.match(prompt, /\"format\":\"two-person-conversation\"/);
  assert.match(prompt, /spoken cold open/i);
  assert.match(prompt, /understand the first time she hears it/i);
  assert.match(prompt, /remove needless repetition/i);
  assert.match(prompt, /Do not use em dashes, en dashes/i);
  assert.match(prompt, /Never return read\.playbook, listen\.brief/);
  assert.match(prompt, /Participants reported fewer intrusive thoughts/);
  assert.doesNotMatch(prompt, /NotebookLM/i);
});

test('writer output is bound to immutable snapshots and must quote accepted evidence', () => {
  const parsed = parseNarrativeWriterResponse(candidate(), [source]);
  assert.equal(parsed.payload.claims[0]?.citations[0]?.snapshotArtifactId, snapshotArtifactId);
  assert.equal(runDeterministicChecks({
    candidate: parsed,
    evidence: { sources: [{ sourceId: source.sourceId, title: source.title, snapshotArtifactId }] },
  }).passed, true);

  const unsupported = candidate();
  unsupported.payload.claims[0]!.citations[0]!.excerpt = 'A sentence that is not in the accepted evidence.';
  assert.throws(
    () => parseNarrativeWriterResponse(unsupported, [source]),
    /narrative_writer_citation_excerpt_mismatch/,
  );
});

test('writer evidence matching tolerates typographic quotation differences', () => {
  const typographicSource = {
    ...source,
    text: "Bloom’s taxonomy calls this learners’ ability to apply knowledge in new situations.",
  };
  const typographicCandidate = candidate();
  typographicCandidate.payload.claims[0]!.citations[0]!.excerpt = "Bloom's taxonomy calls this learners' ability to apply knowledge in new situations.";

  const parsed = parseNarrativeWriterResponse(typographicCandidate, [typographicSource]);
  assert.equal(
    parsed.payload.claims[0]?.citations[0]?.snapshotArtifactId,
    snapshotArtifactId,
  );
});

test('deterministic checks reject typographic punctuation in authored V2 copy', () => {
  const punctuated = candidate();
  punctuated.payload.identity.deck = 'The meeting feels settled—before anyone checks the plan.';
  const parsed = parseNarrativeWriterResponse(punctuated, [source]);
  const report = runDeterministicChecks({
    candidate: parsed,
    evidence: { sources: [{ sourceId: source.sourceId, title: source.title, snapshotArtifactId }] },
  });

  assert.equal(report.passed, false);
  assert.ok(report.findings.some(({ code }) => code === 'narrative-readability'));
});

test('independent editorial QA reviews the V2 narrative with its own recipe call', async () => {
  const parsed = parseNarrativeWriterResponse(candidate(), [source]);
  let calls = 0;
  const provider = new PiEditorialProvider({
    client: {
      async check() {
        calls += 1;
        return { summary: 'Clear, grounded, and story-led.', findings: [] };
      },
    },
    context: async () => ({
      candidate: parsed,
      evidence: { sources: [{ sourceId: source.sourceId, title: source.title, snapshotArtifactId }] },
      rubric: 'Review the single narrative independently.',
      generationPlan: plan(),
      editorialRecipe: recipe('nuglet.qa.editorial'),
    }),
    model: 'independent-qa-model',
  });

  const result = await provider.execute({
    ...executionInput(),
    action: 'check_content',
  });
  assert.equal(result.kind, 'success');
  assert.equal(calls, 1);
  assert.match(result.kind === 'success'
    ? String((result.executionReport as { renderedPrompt?: unknown }).renderedPrompt)
    : '', /Review context/);
});

test('writer provider creates learner text without calling NotebookLM', async () => {
  let calls = 0;
  const provider = new NarrativeWriterProvider({
    client: {
      async write() {
        calls += 1;
        return candidate();
      },
    },
    context: async () => context(),
    model: 'writer-model',
  });

  const result = await provider.execute(executionInput());
  assert.equal(result.kind, 'success');
  assert.equal(calls, 1);
  assert.equal(result.kind === 'success'
    ? (result.parsedOutput as { kind?: unknown }).kind
    : null, 'nuglet.lesson.v2');
  assert.equal(result.kind === 'success' ? result.supportArtifacts?.length : null, 4);
});

test('creation router preserves V1 compatibility and sends V2 only to the writer', async () => {
  const calls: string[] = [];
  const fake = (name: string): ContentProvider => ({
    name,
    capabilities: ['create_content'],
    async execute() {
      calls.push(name);
      return { kind: 'success', rawResponse: Buffer.from('{}'), parsedOutput: {}, executionReport: {} };
    },
  });
  const router = new ContentCreationRouterProvider({
    legacy: fake('legacy-notebooklm'),
    narrative: fake('narrative-writer'),
  });

  await router.execute(executionInput('nuglet.lesson.v2'));
  await router.execute(executionInput('nuglet.lesson.v1'));
  assert.deepEqual(calls, ['narrative-writer', 'legacy-notebooklm']);
});
