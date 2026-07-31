import {
  nugletNarrativeDraftContractDescriptor,
  nugletNarrativeDraftTargetSchema,
  type NugletNarrativeGenerationPlan,
} from '@knowledge-bits/contracts';

import { renderPromptSections } from '../recipes/file-registry.js';
import { generationSupportArtifacts } from '../recipes/support-artifacts.js';
import type { ResolvedRecipe } from '../recipes/types.js';
import {
  ProviderNeedsHumanError,
  type ContentProvider,
  type ProviderExecution,
  type ProviderExecutionInput,
} from './types.js';

export interface NarrativeWriterSource {
  sourceId: string;
  title: string;
  snapshotArtifactId: string;
  text: string;
}

export interface NarrativeWriterContext {
  topic: string;
  locale: string;
  audience: string;
  objective: string;
  generationPlan: NugletNarrativeGenerationPlan;
  recipes: {
    writer: ResolvedRecipe;
    challenge: ResolvedRecipe;
  };
  sources: readonly NarrativeWriterSource[];
}

export interface NarrativeWriterClient {
  write(input: {
    renderedPrompt: string;
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<unknown>;
}

export class NarrativeWriterProvider implements ContentProvider {
  readonly name = 'narrative-writer';
  readonly capabilities = ['create_content'] as const;

  constructor(private readonly options: {
    client: NarrativeWriterClient;
    context: (input: ProviderExecutionInput) => Promise<NarrativeWriterContext>;
    model: string;
  }) {}

  async execute(input: ProviderExecutionInput): Promise<ProviderExecution> {
    if (input.action !== 'create_content') {
      throw new ProviderNeedsHumanError(`narrative_writer_unsupported_action:${input.action}`);
    }
    const context = await this.options.context(input);
    if (context.sources.length === 0) {
      throw new ProviderNeedsHumanError('narrative_writer_evidence_missing', 'quality');
    }

    const promptBytes = renderNarrativeWriterPrompt(context);
    const renderedPrompt = Buffer.from(promptBytes).toString('utf8');
    const response = await this.options.client.write({
      renderedPrompt,
      idempotencyKey: input.idempotencyKey,
      signal: input.signal,
    });
    const candidate = parseNarrativeWriterResponse(response, context.sources);

    return {
      kind: 'success',
      rawResponse: Buffer.from(JSON.stringify(response)),
      parsedOutput: candidate,
      executionReport: {
        promptVersion: `${context.recipes.writer.id}@${context.recipes.writer.version}`,
        provider: this.name,
        model: this.options.model,
        renderedPrompt,
        sourceIds: context.sources.map(({ sourceId }) => sourceId),
      },
      supportArtifacts: [
        ...generationSupportArtifacts({
          recipe: context.recipes.writer,
          prompt: promptBytes,
          model: this.options.model,
          executionInput: input,
        }),
        ...generationSupportArtifacts({
          recipe: context.recipes.challenge,
          prompt: promptBytes,
          model: this.options.model,
          executionInput: input,
        }),
      ],
    };
  }
}

export function renderNarrativeWriterPrompt(context: NarrativeWriterContext): Uint8Array {
  return renderPromptSections([
    'You are the writer for Nuglet. Return one strict JSON object and no markdown.',
    'The object must match this contract exactly:',
    JSON.stringify(nugletNarrativeDraftContractDescriptor),
    [
      'The contract description above is instruction metadata, not the response.',
      'Do not return descriptorVersion, target, outputEnvelope, productRule, narrativeArc, voice, or grounding.',
      'Return exactly the top-level keys kind, schemaVersion, and payload.',
      'Replace every angle-bracket placeholder in the skeleton below with a real value.',
      'The five lesson sections and three quiz questions shown are required. Repeat claim, citation, source, terminology, and coverage items only as needed.',
    ].join('\n'),
    'Exact response skeleton:',
    JSON.stringify(narrativeWriterResponseSkeleton),
    'Approved lesson-writing recipe:',
    Buffer.from(context.recipes.writer.canonicalBytes).toString('utf8'),
    'Approved challenge recipe:',
    Buffer.from(context.recipes.challenge.canonicalBytes).toString('utf8'),
    'Assignment:',
    JSON.stringify({
      topic: context.topic,
      locale: context.locale,
      audience: context.audience,
      objective: context.objective,
    }),
    'Accepted evidence snapshots:',
    JSON.stringify(context.sources.map(({ sourceId, title, text }) => ({ sourceId, title, text }))),
    [
      'Evidence rules:',
      '- Use only the accepted source IDs above.',
      '- Every factual claim needs at least one citation with a verbatim excerpt from the matching evidence text.',
      '- Do not invent snapshotArtifactId values; return sourceId and excerpt and the system will bind the immutable snapshot.',
      '- If the evidence cannot support a useful statement, omit the statement.',
      '- Return exactly one read.lesson and one listen.conversation brief. Never return read.playbook, listen.brief, or another learner article.',
    ].join('\n'),
  ]);
}

const claimUuid = '<real UUID also declared in payload.claims>';
const quizQuestion = (id: string) => ({
  id,
  prompt: '<realistic application question>',
  options: [
    { id: 'a', text: '<plausible answer>' },
    { id: 'b', text: '<plausible answer>' },
    { id: 'c', text: '<plausible answer>' },
  ],
  correctOptionId: '<a, b, or c>',
  rationale: '<plain-language explanation>',
  claimRefs: [claimUuid],
});

const narrativeWriterResponseSkeleton = {
  kind: 'nuglet.lesson.v2',
  schemaVersion: '2.0.0',
  payload: {
    contentModel: 'single-narrative.v2',
    materialization: 'draft',
    identity: {
      locale: '<locale>',
      topic: { label: '<plain-language topic>', categoryId: null },
      tags: ['<tag>'],
      title: '<learner-facing title>',
      deck: '<one-sentence invitation>',
      slugSuggestion: '<lowercase-hyphenated-slug>',
    },
    learning: {
      oneLineToKeep: '<one memorable sentence>',
      action: { label: '<short action label>', instruction: '<one concrete instruction>' },
      terminology: [{ term: '<necessary term>', plainLanguage: '<immediate everyday explanation>' }],
    },
    hero: {
      altText: '<useful image description>',
      accessibilityPurpose: 'informative',
      mediaBrief: {
        concept: '<visual concept>',
        metaphor: '<specific physical metaphor>',
        compositionFamily: 'asymmetrical-story',
      },
    },
    read: {
      lesson: {
        title: '<same canonical lesson title>',
        estimatedMinutes: 5,
        sections: [
          { id: 'scene', type: 'scene', text: '<recognizable opening moment>', claimRefs: [] },
          { id: 'discovery', type: 'discovery', text: '<tension and useful discovery>', claimRefs: [claimUuid] },
          { id: 'evidence', type: 'evidence', text: '<plain-language evidence woven into the story>', claimRefs: [claimUuid] },
          { id: 'application', type: 'application', text: '<idea applied in a realistic moment>', claimRefs: [claimUuid] },
          { id: 'close', type: 'close', text: '<story-led close and practical shift>', claimRefs: [] },
        ],
      },
    },
    visual: {
      title: '<visual title>',
      altText: '<visual description>',
      textEquivalent: ['<key point in text form>'],
      claimRefs: [claimUuid],
      mediaBrief: { objective: '<what the visual should clarify>', structure: '<simple visual structure>' },
    },
    listen: {
      conversation: {
        editorialBrief: {
          objective: '<what two people should explore>',
          tone: 'warm, curious, and natural',
          keyPoints: ['<moment from the lesson>', '<useful idea>', '<practical shift>'],
          format: 'two-person-conversation',
        },
      },
    },
    quiz: {
      questions: [
        quizQuestion('q1'),
        quizQuestion('q2'),
        quizQuestion('q3'),
      ],
    },
    publicSources: [{
      evidenceSourceId: '<accepted sourceId>',
      label: '<reader-facing source label>',
      publisher: '<publisher>',
    }],
    claims: [{
      claimId: claimUuid,
      statement: '<one factual statement used by the lesson>',
      citations: [{
        sourceId: '<accepted sourceId>',
        excerpt: '<verbatim excerpt from the matching evidence text>',
      }],
    }],
    claimCoverage: [
      { path: 'read.lesson', claimIds: [claimUuid] },
      { path: 'visual', claimIds: [claimUuid] },
      { path: 'listen.conversation', claimIds: [claimUuid] },
      { path: 'quiz', claimIds: [claimUuid] },
    ],
  },
} as const;

export function parseNarrativeWriterResponse(
  response: unknown,
  sources: readonly NarrativeWriterSource[],
) {
  const value = writerResponseObject(response);
  const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
  const candidate = structuredClone(value);
  const payload = recordValue(candidate.payload);
  if (!payload || !Array.isArray(payload.claims)) {
    throw new ProviderNeedsHumanError('narrative_writer_content_invalid', 'quality');
  }

  payload.claims = payload.claims.map((rawClaim) => {
    const claim = recordValue(rawClaim);
    if (!claim || !Array.isArray(claim.citations)) {
      throw new ProviderNeedsHumanError('narrative_writer_citation_missing', 'quality');
    }
    return {
      ...claim,
      citations: claim.citations.map((rawCitation) => {
        const citation = recordValue(rawCitation);
        const sourceId = citation?.sourceId;
        const excerpt = citation?.excerpt;
        if (typeof sourceId !== 'string' || typeof excerpt !== 'string') {
          throw new ProviderNeedsHumanError('narrative_writer_citation_missing', 'quality');
        }
        const source = sourceById.get(sourceId);
        if (!source) {
          throw new ProviderNeedsHumanError('narrative_writer_citation_source_missing', 'quality');
        }
        if (!normalizedEvidenceText(source.text).includes(normalizedEvidenceText(excerpt))) {
          throw new ProviderNeedsHumanError('narrative_writer_citation_excerpt_mismatch', 'quality');
        }
        return {
          ...citation,
          sourceId,
          snapshotArtifactId: source.snapshotArtifactId,
          excerpt: excerpt.trim(),
        };
      }),
    };
  });

  const parsed = nugletNarrativeDraftTargetSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ProviderNeedsHumanError('narrative_writer_content_invalid', 'quality');
  }
  return parsed.data;
}

function writerResponseObject(response: unknown): Record<string, unknown> {
  if (typeof response === 'string') {
    try {
      const unfenced = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const parsed: unknown = JSON.parse(unfenced);
      const record = recordValue(parsed);
      if (record) return record;
    } catch {
      // Fall through to the typed quality failure below.
    }
    throw new ProviderNeedsHumanError('narrative_writer_invalid_response', 'quality');
  }
  const record = recordValue(response);
  if (!record) throw new ProviderNeedsHumanError('narrative_writer_invalid_response', 'quality');
  return record;
}

function normalizedEvidenceText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en');
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
