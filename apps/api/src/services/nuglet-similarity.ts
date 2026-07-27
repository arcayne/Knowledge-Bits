import { createHash } from 'node:crypto';

import {
  nugletSimilarityResponseSchema,
  type NugletSimilarityMatch,
  type NugletSimilarityRequest,
  type NugletSimilarityResponse,
} from '@knowledge-bits/contracts';

import type { WorkflowRun } from '../repositories/workflow-repository.js';

const MAX_MATCHES = 5;
const RELATED_THRESHOLD = 0.3;
const LIKELY_DUPLICATE_THRESHOLD = 0.8;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'because', 'but', 'by', 'can', 'do',
  'does', 'for', 'from', 'how', 'i', 'in', 'is', 'it', 'make', 'of', 'on', 'or',
  'people', 'that', 'the', 'their', 'this', 'to', 'what', 'when', 'why', 'with',
  'you', 'your',
]);

const CONCEPT_ALIASES: ReadonlyArray<readonly [string, ReadonlySet<string>]> = [
  ['attention', new Set(['attention', 'distract', 'distraction', 'focus', 'focused'])],
  ['decision_choice', new Set(['choice', 'choose', 'decide', 'decision', 'judgment', 'judgement'])],
  ['decision_bias', new Set(['bias', 'biased', 'heuristic', 'irrational', 'rational'])],
  ['learning_memory', new Set(['forget', 'learn', 'learning', 'memory', 'remember', 'retention'])],
  ['procrastination', new Set(['delay', 'procrastinate', 'procrastination'])],
  ['social_proof', new Set(['conformity', 'crowd', 'socialproof'])],
];

export function analyzeNugletSimilarity(
  input: NugletSimilarityRequest,
  runs: readonly WorkflowRun[],
): NugletSimilarityResponse {
  const query = signalsFor(input.title, input.objective);
  const matches = runs
    .map((run) => matchRun(query, run))
    .filter((match): match is NugletSimilarityMatch => match !== null)
    .sort((left, right) => right.score - left.score || left.runId.localeCompare(right.runId))
    .slice(0, MAX_MATCHES);
  const risk = matches.some((match) => match.score >= LIKELY_DUPLICATE_THRESHOLD)
    ? 'likely_duplicate'
    : matches.length
      ? 'related'
      : 'none';
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({
      query: {
        title: normalizeText(input.title),
        objective: normalizeText(input.objective),
        audience: normalizeText(input.audience ?? ''),
        locale: input.locale.trim().toLowerCase(),
      },
      matches: matches.map(({ runId, score }) => ({ runId, score })),
    }))
    .digest('hex');
  return nugletSimilarityResponseSchema.parse({
    method: 'deterministic_intake_v1',
    scope: 'all_knowledge_bits_runs',
    fingerprint,
    risk,
    matches,
  });
}

function matchRun(query: TextSignals, run: WorkflowRun): NugletSimilarityMatch | null {
  const objective = stringValue(run.brief.objective);
  const candidate = signalsFor(
    [run.title, stringValue(run.brief.title), stringValue(run.brief.topic)].filter(Boolean).join(' '),
    [
      objective,
      stringArray(run.brief.researchQuestions).join(' '),
      stringArray(run.brief.evidenceNotes).join(' '),
    ].filter(Boolean).join(' '),
  );
  const exactTitle = query.normalizedTitle === normalizeText(run.title);
  const titleOverlap = overlapCoefficient(query.titleTerms, candidate.titleTerms);
  const objectiveOverlap = overlapCoefficient(query.objectiveTerms, candidate.objectiveTerms);
  const combinedOverlap = overlapCoefficient(query.allTerms, candidate.allTerms);
  const conceptOverlap = overlapCoefficient(query.concepts, candidate.concepts);
  const score = exactTitle
    ? 1
    : roundScore(Math.max(
      (0.65 * titleOverlap) + (0.25 * objectiveOverlap) + (0.1 * combinedOverlap),
      (0.55 * conceptOverlap) + (0.25 * titleOverlap) + (0.2 * combinedOverlap),
    ));
  if (score < RELATED_THRESHOLD) return null;

  const sharedTitleTerms = intersection(query.titleTerms, candidate.titleTerms);
  const sharedConcepts = intersection(query.concepts, candidate.concepts);
  const reasons = [
    ...(exactTitle ? ['same normalized title'] : []),
    ...(sharedTitleTerms.length ? [`shared title terms: ${sharedTitleTerms.join(', ')}`] : []),
    ...(sharedConcepts.length ? [`shared concepts: ${sharedConcepts.join(', ')}`] : []),
    ...(objectiveOverlap >= 0.4 ? ['substantial objective overlap'] : []),
    ...(!exactTitle && !sharedTitleTerms.length && !sharedConcepts.length ? ['substantial intake-language overlap'] : []),
  ];
  return {
    runId: run.id,
    title: run.title,
    objective: objective ?? null,
    locale: run.locale,
    currentStage: run.currentStage,
    reviewStatus: run.reviewStatus,
    score,
    reasons,
    reviewPath: `/runs/${run.id}`,
  };
}

interface TextSignals {
  normalizedTitle: string;
  titleTerms: Set<string>;
  objectiveTerms: Set<string>;
  allTerms: Set<string>;
  concepts: Set<string>;
}

function signalsFor(title: string, objective: string): TextSignals {
  const normalizedTitle = normalizeText(title);
  const titleTerms = terms(normalizedTitle);
  const objectiveTerms = terms(normalizeText(objective));
  const allTerms = new Set([...titleTerms, ...objectiveTerms]);
  return {
    normalizedTitle,
    titleTerms,
    objectiveTerms,
    allTerms,
    concepts: conceptsFor(allTerms),
  };
}

function terms(value: string): Set<string> {
  return new Set((value.match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term))
    .map(stem)
    .filter((term) => term.length > 1));
}

function conceptsFor(terms: ReadonlySet<string>): Set<string> {
  const concepts = new Set<string>();
  for (const [concept, aliases] of CONCEPT_ALIASES) {
    if ([...terms].some((term) => aliases.has(term))) concepts.add(concept);
  }
  if (terms.has('decision') && (terms.has('bad') || terms.has('smart'))) {
    concepts.add('decision_bias');
  }
  return concepts;
}

function normalizeText(value: string): string {
  return value.normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function stem(value: string): string {
  if (value.length > 5 && value.endsWith('ing')) return value.slice(0, -3);
  if (value.length > 4 && value.endsWith('ied')) return `${value.slice(0, -3)}y`;
  if (value.length > 4 && value.endsWith('ed')) return value.slice(0, -2);
  if (value.length > 4 && value.endsWith('ies')) return `${value.slice(0, -3)}y`;
  if (value.length > 4 && /(?:ses|xes|zes|ches|shes)$/.test(value)) return value.slice(0, -2);
  if (value.length > 3 && value.endsWith('s')) return value.slice(0, -1);
  return value;
}

function overlapCoefficient(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (!left.size || !right.size) return 0;
  return intersection(left, right).length / Math.min(left.size, right.size);
}

function intersection(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((value) => right.has(value)).sort();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    : [];
}

function roundScore(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1_000) / 1_000;
}
