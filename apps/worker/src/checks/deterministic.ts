import type { NugletLessonV1Payload, StoryPlaybookDraft } from '@knowledge-bits/contracts';
import { calculateContentChecksum } from '@knowledge-bits/pipeline';

export interface GroundedCitation {
  sourceId: string;
  snapshotArtifactId: string;
  excerpt: string;
}

export interface GroundedClaim {
  claimId: string;
  statement: string;
  citations: readonly GroundedCitation[];
}

export interface StoryPlaybookDraftTarget {
  kind: 'nuglet.lesson.v1';
  schemaVersion: '1.1.0';
  payload: StoryPlaybookDraft;
}

export type ContentCandidate = NugletLessonV1Payload | StoryPlaybookDraftTarget;

export interface EvidenceManifest {
  sources: readonly { sourceId: string; title: string; snapshotArtifactId: string }[];
}

export interface DeterministicFinding {
  code:
    | 'placeholder'
    | 'duplicate-depth'
    | 'story-integrity'
    | 'playbook-structure'
    | 'cross-format-consistency'
    | 'challenge-shape'
    | 'citation-source'
    | 'citation-excerpt'
    | 'content-shape'
    | 'claim-inventory'
    | 'claim-coverage';
  message: string;
}

export interface DeterministicCheckReport {
  passed: boolean;
  contentChecksum: string;
  findings: readonly DeterministicFinding[];
}

const PLACEHOLDER = /\b(?:todo|tbd|placeholder|opportunity score|competitor)\b/i;
const LEGACY_LEARNER_PATHS = ['title', 'takeaway', 'action', 'depths.quick', 'depths.core', 'depths.deep'] as const;
const STORY_PLAYBOOK_LEARNER_PATHS = [
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
] as const;

export function runDeterministicChecks(input: {
  candidate: ContentCandidate;
  evidence: EvidenceManifest;
}): DeterministicCheckReport {
  const findings: DeterministicFinding[] = [];
  if (isStoryPlaybookCandidate(input.candidate)) {
    checkStoryPlaybook(input.candidate.payload, findings);
  } else {
    checkLegacy(input.candidate, findings);
  }
  checkClaims(input.candidate, input.evidence, findings);

  return {
    passed: findings.length === 0,
    contentChecksum: calculateContentChecksum(input.candidate),
    findings,
  };
}

export function isStoryPlaybookCandidate(candidate: ContentCandidate): candidate is StoryPlaybookDraftTarget {
  return 'schemaVersion' in candidate
    && candidate.schemaVersion === '1.1.0'
    && 'payload' in candidate;
}

function checkLegacy(candidate: NugletLessonV1Payload, findings: DeterministicFinding[]): void {
  const fields = [
    candidate.title,
    candidate.takeaway,
    candidate.action,
    candidate.depths.quick,
    candidate.depths.core,
    candidate.depths.deep,
  ];
  if (fields.some((value) => !value?.trim())) {
    findings.push({ code: 'content-shape', message: 'Candidate requires all learner-facing fields.' });
  }
  if (fields.some((value) => PLACEHOLDER.test(value))) {
    findings.push({ code: 'placeholder', message: 'Candidate contains a placeholder or internal metadata label.' });
  }

  const depths = Object.values(candidate.depths).map(normalize);
  if (new Set(depths).size !== depths.length) {
    findings.push({ code: 'duplicate-depth', message: 'Quick, Core, and Deep content must be distinct.' });
  }

  checkCoverage(candidate.claims, candidate.claimCoverage, LEGACY_LEARNER_PATHS, [], findings);
}

function checkStoryPlaybook(payload: StoryPlaybookDraft, findings: DeterministicFinding[]): void {
  const learnerText = stringValues({
    identity: payload.identity,
    learning: payload.learning,
    read: payload.read,
    visual: payload.visual,
    listen: payload.listen,
    quiz: payload.quiz,
  });
  if (learnerText.some((value) => PLACEHOLDER.test(value))) {
    findings.push({ code: 'placeholder', message: 'Candidate contains a placeholder or internal metadata label.' });
  }

  const story = payload.read.story;
  const storyTypes = new Set(story.blocks.map(({ type }) => type));
  const requiredStoryTypes = ['opening', 'turning_point', 'practical_bridge'] as const;
  const hasNarrativeArc = requiredStoryTypes.every((type) => storyTypes.has(type));
  const evidenceBlocks = story.blocks.filter(({ type }) => type === 'evidence');
  if (!hasNarrativeArc || evidenceBlocks.length === 0 || evidenceBlocks.some(({ claimRefs }) => claimRefs.length === 0)) {
    findings.push({
      code: 'story-integrity',
      message: 'Story requires an opening, evidence-bound factual block, turning point, and practical bridge.',
    });
  }

  const playbook = payload.read.playbook;
  const stepIds = new Set(playbook.steps.map(({ id }) => id));
  if (!playbook.principle.trim()
    || !playbook.whyItMatters.trim()
    || playbook.steps.length < 3
    || playbook.steps.length > 5
    || stepIds.size !== playbook.steps.length
    || playbook.steps.some(({ title, body }) => !title.trim() || !body.trim())
    || !playbook.example.title.trim()
    || !playbook.example.body.trim()
    || playbook.watchOuts.length === 0
    || playbook.watchOuts.some((watchOut) => !watchOut.trim())
    || !playbook.action.trim()) {
    findings.push({
      code: 'playbook-structure',
      message: 'Playbook requires one principle, why it matters, three to five distinct steps, one example, watch-outs, and the shared action.',
    });
  }

  const storySegments = story.blocks.map(({ text }) => semanticNormalize(text));
  const playbookSegments = [
    playbook.principle,
    playbook.whyItMatters,
    ...playbook.steps.flatMap(({ title, body }) => [title, body]),
    playbook.example.title,
    playbook.example.body,
    ...playbook.watchOuts,
    playbook.action,
  ].map(semanticNormalize);
  const storyText = storySegments.join(' ');
  const playbookText = playbookSegments.join(' ');
  const sharedValues = [
    semanticNormalize(payload.learning.centralIdea),
    semanticNormalize(payload.learning.oneLineToKeep),
    semanticNormalize(payload.learning.action.instruction),
  ];
  const sharedValuesPresent = sharedValues.every((value) => value && storyText.includes(value) && playbookText.includes(value));
  const actionMatches = semanticNormalize(playbook.action) === semanticNormalize(payload.learning.action.instruction);
  const normalizedDuplicate = sameNormalizedSet(storySegments, playbookSegments)
    || storyText === playbookText
    || tokenSimilarity(storyText, playbookText) >= 0.9;
  if (!sharedValuesPresent || !actionMatches || normalizedDuplicate) {
    findings.push({
      code: 'cross-format-consistency',
      message: 'Story and Playbook must share the central idea, line to keep, terminology, and action without becoming normalized duplicates.',
    });
  }

  const questions = payload.quiz.questions;
  const questionIds = new Set(questions.map(({ id }) => id));
  const malformedQuestion = questions.some((question) => {
    const optionIds = new Set(question.options.map(({ id }) => id));
    return !question.id.trim()
      || !question.prompt.trim()
      || question.options.length < 3
      || question.options.length > 4
      || optionIds.size !== question.options.length
      || !optionIds.has(question.correctOptionId)
      || !question.rationale.trim()
      || !question.reviewConcept.trim();
  });
  if (questions.length !== 3 || questionIds.size !== questions.length || malformedQuestion) {
    findings.push({
      code: 'challenge-shape',
      message: 'Challenge requires exactly three valid application questions.',
    });
  }

  const nestedClaimRefs = [
    ...story.blocks.flatMap(({ claimRefs }) => claimRefs.map((claimId) => ({ path: 'read.story', claimId }))),
    ...playbook.steps.flatMap(({ claimRefs }) => claimRefs.map((claimId) => ({ path: 'read.playbook', claimId }))),
    ...playbook.example.claimRefs.map((claimId) => ({ path: 'read.playbook', claimId })),
    ...payload.visual.claimRefs.map((claimId) => ({ path: 'visual', claimId })),
    ...questions.flatMap(({ claimRefs }) => claimRefs.map((claimId) => ({ path: 'quiz', claimId }))),
  ];
  checkCoverage(payload.claims, payload.claimCoverage, STORY_PLAYBOOK_LEARNER_PATHS, nestedClaimRefs, findings);
}

function checkClaims(
  candidate: ContentCandidate,
  evidence: EvidenceManifest,
  findings: DeterministicFinding[],
): void {
  const claims = isStoryPlaybookCandidate(candidate) ? candidate.payload.claims : candidate.claims;
  if (claims.length === 0) {
    findings.push({ code: 'claim-inventory', message: 'Learner content requires at least one supported claim.' });
  }

  const sourcesById = new Map(evidence.sources.map((source) => [source.sourceId, source]));
  for (const claim of claims) {
    if (!claim.claimId.trim() || !claim.statement.trim() || claim.citations.length === 0) {
      findings.push({ code: 'citation-source', message: 'Every factual claim requires a cited source.' });
      continue;
    }
    for (const citation of claim.citations) {
      const source = sourcesById.get(citation.sourceId);
      if (!source || source.snapshotArtifactId !== citation.snapshotArtifactId) {
        findings.push({ code: 'citation-source', message: `Citation source ${citation.sourceId} is not in the evidence manifest.` });
      }
      if (!citation.excerpt.trim()) {
        findings.push({ code: 'citation-excerpt', message: 'Every citation requires a non-empty excerpt.' });
      }
    }
  }
}

function checkCoverage(
  claims: readonly GroundedClaim[],
  coverageEntries: readonly { path: string; claimIds: readonly string[] }[],
  requiredPaths: readonly string[],
  nestedClaimRefs: readonly { path: string; claimId: string }[],
  findings: DeterministicFinding[],
): void {
  const claimsById = new Map(claims.map((claim) => [claim.claimId, claim]));
  const coverageByPath = new Map(coverageEntries.map((coverage) => [coverage.path, coverage]));
  let invalid = coverageByPath.size !== coverageEntries.length;
  for (const path of requiredPaths) {
    const coverage = coverageByPath.get(path);
    if (!coverage || coverage.claimIds.length === 0 || coverage.claimIds.some((claimId) => !claimsById.has(claimId))) {
      invalid = true;
    }
  }
  for (const { path, claimId } of nestedClaimRefs) {
    if (!claimsById.has(claimId) || !coverageByPath.get(path)?.claimIds.includes(claimId)) {
      invalid = true;
    }
  }
  if (invalid) {
    findings.push({ code: 'claim-coverage', message: 'Every learner path and nested factual reference requires valid claim coverage.' });
  }
}

function sameNormalizedSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left.filter(Boolean));
  const rightSet = new Set(right.filter(Boolean));
  return leftSet.size > 0
    && leftSet.size === rightSet.size
    && [...leftSet].every((value) => rightSet.has(value));
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = new Set(left.split(' ').filter(Boolean));
  const rightTokens = new Set(right.split(' ').filter(Boolean));
  const union = new Set([...leftTokens, ...rightTokens]);
  if (union.size === 0) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token));
  return intersection.length / union.size;
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(stringValues);
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function semanticNormalize(value: string): string {
  return normalize(value).replace(/[^a-z0-9]+/g, ' ').trim();
}
