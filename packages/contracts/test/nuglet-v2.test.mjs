import assert from 'node:assert/strict';
import test from 'node:test';

import {
  knowledgeBitsContentSchema,
  knowledgeBitsRunBriefSchema,
  nugletNarrativeDraftContractDescriptor,
  nugletNarrativeDraftTargetSchema,
  nugletNarrativeGenerationPlanSchema,
} from '../dist/index.js';

const claimId = '0f8fad5b-d9cb-469f-a165-708677289510';
const snapshotArtifactId = '0f8fad5b-d9cb-469f-a165-708677289512';

function binding(id, digit) {
  return { id, version: '1.0.0', checksum: `sha256:${digit.repeat(64)}` };
}

function plan() {
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
      concept: 'A crowded desk with one clear page',
      metaphor: 'Choosing one useful thought',
      compositionFamily: 'asymmetrical-story',
      mustInclude: ['one focal action'],
      mustAvoid: ['generic icons'],
    },
    mediaMode: 'generate',
  };
}

function target() {
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
        terminology: [{
          term: 'Zeigarnik effect',
          plainLanguage: 'unfinished tasks can stay mentally active',
        }],
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
            { id: 'discovery', type: 'discovery', text: 'The problem was not that she cared too much. Her mind had no clear ending to hold on to.', claimRefs: [] },
            { id: 'evidence', type: 'evidence', text: 'Researchers have found that unfinished tasks can remain mentally active until we make a workable plan.', claimRefs },
            { id: 'application', type: 'application', text: 'A specific next action gives the thought somewhere to land.', claimRefs },
            { id: 'close', type: 'close', text: 'She wrote one sentence, shut the notebook, and the evening finally felt like hers.', claimRefs: [] },
          ],
        },
      },
      visual: {
        title: 'Give the thought somewhere to land',
        altText: 'An unfinished thought moves into one written next step.',
        textEquivalent: ['Unfinished thought', 'Name the next action', 'Return later'],
        claimRefs,
        mediaBrief: { objective: 'Show the shift from rumination to a concrete plan', structure: 'one simple before-and-after path' },
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
        statement: 'Unfinished tasks can remain mentally active until a workable plan is formed.',
        citations: [{ sourceId: 'source-1', snapshotArtifactId, excerpt: 'Participants reported fewer intrusive thoughts after forming a specific plan.' }],
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

test('V2 contract contains exactly one written lesson and one Conversation', () => {
  const parsed = nugletNarrativeDraftTargetSchema.parse(target());
  assert.equal(parsed.payload.read.lesson.sections.length, 5);
  assert.deepEqual(Object.keys(parsed.payload.read), ['lesson']);
  assert.deepEqual(Object.keys(parsed.payload.listen), ['conversation']);
  assert.equal('playbook' in parsed.payload.read, false);
  assert.equal('brief' in parsed.payload.listen, false);
  assert.deepEqual(nugletNarrativeDraftContractDescriptor.productRule, {
    writtenLessonCount: 1,
    writtenLessonPath: 'payload.read.lesson',
    audioCount: 1,
    audioPath: 'payload.listen.conversation',
    forbiddenParallelFormats: ['playbook', 'brief audio', 'summary article'],
  });
});

test('V2 plan has a writer recipe and no NotebookLM text or Brief-audio role', () => {
  const parsed = nugletNarrativeGenerationPlanSchema.parse(plan());
  assert.equal(parsed.recipes.writer.id, 'nuglet.lesson.narrative');
  assert.equal(parsed.recipes.audioConversation.id, 'nuglet.audio.conversation');
  assert.equal('story' in parsed.recipes, false);
  assert.equal('playbook' in parsed.recipes, false);
  assert.equal('audioBrief' in parsed.recipes, false);
});

test('V2 content remains additive and is accepted beside V1 content', () => {
  const content = knowledgeBitsContentSchema.parse({
    schemaVersion: 'knowledge-bits.content.v1',
    target: target(),
  });
  assert.equal(content.target.kind, 'nuglet.lesson.v2');

  const brief = knowledgeBitsRunBriefSchema.parse({
    contentKind: 'nuglet.lesson.v2',
    notebookLmNotebookId: 'research-notebook',
    generationPlan: plan(),
  });
  assert.equal(brief.contentKind, 'nuglet.lesson.v2');
});

test('V2 rejects a second written format or second audio format', () => {
  const withPlaybook = structuredClone(target());
  withPlaybook.payload.read.playbook = { title: 'Parallel explanation' };
  assert.equal(nugletNarrativeDraftTargetSchema.safeParse(withPlaybook).success, false);

  const withBrief = structuredClone(target());
  withBrief.payload.listen.brief = { editorialBrief: { objective: 'Summary' } };
  assert.equal(nugletNarrativeDraftTargetSchema.safeParse(withBrief).success, false);
});
