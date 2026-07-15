import {
  NOTEBOOKLM_CREATE_PROMPT_VERSION,
  renderNotebookLmCreatePrompt,
} from '../prompts/notebooklm-create-legacy.v1.js';
import {
  NOTEBOOKLM_RESEARCH_PROMPT_VERSION,
  renderNotebookLmResearchPrompt,
} from '../prompts/notebooklm-research.v1.js';
import type { EvidenceManifest, GroundedClaim } from '../checks/deterministic.js';
import type { VerifiedResearchEvidence } from '../checks/source-verifier.js';
import {
  nugletLessonV1PayloadSchema,
  storyPlaybookDraftContractDescriptor,
  storyPlaybookDraftTargetSchema,
  type NugletGenerationPlan,
} from '@knowledge-bits/contracts';
import { renderPromptSections } from '../recipes/file-registry.js';
import { generationSupportArtifacts } from '../recipes/support-artifacts.js';
import type { ResolvedNugletRecipes, ResolvedRecipe } from '../recipes/types.js';

import {
  ProviderNeedsHumanError,
  ProviderWaitingError,
  type ContentProvider,
  type ProviderExecution,
  type ProviderExecutionInput,
} from './types.js';
import { createHash } from 'node:crypto';

export const DEFAULT_NOTEBOOKLM_TIMEOUT_MS = 180_000;
export const NOTEBOOKLM_RECIPE_CREATE_PROMPT_VERSION = 'notebooklm-recipe-create.v1';
const DEFAULT_NOTEBOOKLM_TRANSPORT_RETRY_SECONDS = 60;
const MAX_NOTEBOOKLM_TRANSPORT_RETRY_SECONDS = 3_600;

export interface PromptInputs {
  topic: string;
  locale: string;
  audience: string;
  objective: string;
  acceptedSourceIds: string[];
  centralIdea?: string;
}

export interface NotebookLmProcess {
  run(input: {
    command: string;
    args: readonly string[];
    stdin?: string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut?: boolean }>;
}

export interface NotebookLmContext {
  notebookId: string;
  sourceUrls: readonly string[];
  topic: string;
  locale?: string;
  audience?: string;
  objective?: string;
  centralIdea?: string;
  evidence?: EvidenceManifest;
  generationPlan?: NugletGenerationPlan;
  resolvedRecipes?: Partial<ResolvedNugletRecipes>;
}

export interface ResearchSourceVerifier {
  verify(value: unknown, signal: AbortSignal): Promise<{
    evidence: VerifiedResearchEvidence;
    snapshots: NonNullable<Extract<ProviderExecution, { kind: 'success' }>['assets']>;
  }>;
}

export class NotebookLmProvider implements ContentProvider {
  readonly name = 'notebooklm';
  readonly capabilities = ['collect_sources', 'create_content'] as const;
  private readonly now: () => Date;

  constructor(private readonly options: {
    process: NotebookLmProcess;
    context: (input: ProviderExecutionInput) => Promise<NotebookLmContext>;
    sourceVerifier?: ResearchSourceVerifier;
    now?: () => Date;
    timeoutMs?: number;
  }) {
    this.now = options.now ?? (() => new Date());
  }

  async execute(input: ProviderExecutionInput): Promise<ProviderExecution> {
    if (input.action !== 'collect_sources' && input.action !== 'create_content') {
      throw new ProviderNeedsHumanError(`notebooklm_unsupported_action:${input.action}`);
    }
    const context = await this.options.context(input);
    const recipeExecution = input.action === 'create_content' && context.generationPlan?.schemaVersion === '1.1.0'
      ? resolvedCreateRecipes(context)
      : undefined;
    const cliVersion = await this.version(input.signal);
    await this.importSources(context, input.signal);
    const promptBytes = input.action === 'collect_sources'
      ? renderPromptSections([renderNotebookLmResearchPrompt({ topic: context.topic })])
      : recipeExecution
        ? renderRecipeCreatePrompt(context, recipeExecution)
        : renderPromptSections([renderNotebookLmCreatePrompt({
          topic: context.topic,
          revision: input.job.revision,
          sources: context.evidence?.sources,
        })]);
    const prompt = Buffer.from(promptBytes).toString('utf8');
    const promptVersion = input.action === 'collect_sources'
      ? NOTEBOOKLM_RESEARCH_PROMPT_VERSION
      : recipeExecution
        ? NOTEBOOKLM_RECIPE_CREATE_PROMPT_VERSION
        : NOTEBOOKLM_CREATE_PROMPT_VERSION;
    const response = await this.query(context.notebookId, prompt, input.signal);
    let parsed = await this.parseOrRepair(context.notebookId, prompt, response, input.signal);
    validateCitations(parsed.answer, input.action === 'create_content' ? context.evidence : undefined);
    if (recipeExecution) {
      const issues = storyPlaybookSemanticIssues(parsed.answer, context.evidence);
      if (issues.length > 0) {
        const semanticRepairPrompt = renderStoryPlaybookSemanticRepairPrompt(issues);
        const semanticRepairResponse = await this.query(
          context.notebookId,
          semanticRepairPrompt,
          input.signal,
          parsed.conversationId,
        );
        const repaired = parseStructuredResponse(semanticRepairResponse.stdout);
        if (!repaired) throw new ProviderNeedsHumanError('notebooklm_malformed_output');
        parsed = {
          ...repaired,
          prompts: [...parsed.prompts, semanticRepairPrompt],
        };
        validateCitations(parsed.answer, context.evidence);
        if (storyPlaybookSemanticIssues(parsed.answer, context.evidence).length > 0) {
          throw new ProviderNeedsHumanError('notebooklm_content_invalid', 'quality');
        }
      }
    }
    const verified = input.action === 'collect_sources'
      ? await this.verifyResearch(parsed.answer, context, input.signal)
      : undefined;
    const parsedOutput = verified?.evidence
      ?? parseCreateOutput(parsed.answer, context.evidence, context.generationPlan);

    return {
      kind: 'success',
      rawResponse: Buffer.from(parsed.raw),
      parsedOutput,
      executionReport: {
        cliVersion,
        conversationId: parsed.conversationId,
        promptVersion,
        provider: this.name,
        renderedPrompt: prompt,
        renderedPrompts: parsed.prompts,
        sourceIds: sourceIds(parsed.answer),
      },
      ...(recipeExecution ? {
        supportArtifacts: parsed.prompts.flatMap((renderedPrompt) => recipeExecution.flatMap((recipe) => (
          generationSupportArtifacts({
            recipe,
            prompt: Buffer.from(renderedPrompt),
            model: `notebooklm-cli:${cliVersion}`,
            executionInput: input,
          })
        ))),
      } : {}),
      ...(verified ? { assets: verified.snapshots } : {}),
    };
  }

  private async verifyResearch(answer: Record<string, unknown>, context: NotebookLmContext, signal: AbortSignal) {
    if (!this.options.sourceVerifier) throw new ProviderNeedsHumanError('source_verifier_unconfigured');
    const candidates = researchCandidates(answer, context.sourceUrls);
    const verified = await this.options.sourceVerifier.verify({ sources: candidates }, signal);
    if (verified.evidence.acceptedSources.length === 0) {
      throw new ProviderNeedsHumanError('research_no_accepted_sources', 'quality');
    }
    return verified;
  }

  private async version(signal: AbortSignal): Promise<string> {
    const response = await this.run(['--version'], signal);
    this.assertProcessSuccess(response);
    const version = response.stdout.trim();
    if (!version) throw new ProviderNeedsHumanError('notebooklm_version_missing');
    return version;
  }

  private async importSources(context: NotebookLmContext, signal: AbortSignal): Promise<void> {
    if (context.sourceUrls.length === 0) return;
    const existing = await this.listSourceUrls(context.notebookId, signal);
    const missing = [...new Set(context.sourceUrls)].filter((url) => !existing.has(url));
    if (missing.length === 0) return;
    const response = await this.run(['source', 'add', context.notebookId, ...missing.flatMap((url) => ['--url', url]), '--wait'], signal);
    this.assertProcessSuccess(response);
  }

  private async listSourceUrls(notebookId: string, signal: AbortSignal): Promise<Set<string>> {
    const response = await this.run(['source', 'list', notebookId, '--json'], signal);
    this.assertProcessSuccess(response);
    try {
      const parsed: unknown = JSON.parse(response.stdout);
      if (!Array.isArray(parsed)) throw new TypeError('source list is not an array');
      return new Set(parsed.flatMap((source) => (
        source && typeof source === 'object' && typeof (source as { url?: unknown }).url === 'string'
          ? [(source as { url: string }).url]
          : []
      )));
    } catch {
      throw new ProviderNeedsHumanError('notebooklm_source_list_invalid');
    }
  }

  private async query(notebookId: string, prompt: string, signal: AbortSignal, conversationId?: string) {
    const response = await this.run([
      'notebook', 'query', notebookId, prompt,
      ...(conversationId ? ['--conversation-id', conversationId] : []),
      '--json',
    ], signal);
    this.assertProcessSuccess(response);
    return response;
  }

  private async parseOrRepair(
    notebookId: string,
    prompt: string,
    response: { stdout: string; stderr: string; exitCode: number | null; timedOut?: boolean },
    signal: AbortSignal,
  ): Promise<{ raw: string; conversationId: string; answer: Record<string, unknown>; prompts: readonly string[] }> {
    const parsed = parseStructuredResponse(response.stdout);
    if (parsed) return { ...parsed, prompts: [prompt] };

    const envelope = parseResponseEnvelope(response.stdout);
    if (!envelope) throw new ProviderNeedsHumanError('notebooklm_malformed_output');
    const repairedPrompt = renderMalformedOutputRepairPrompt();
    const repaired = await this.query(notebookId, repairedPrompt, signal, envelope.conversationId);
    const repairedParsed = parseStructuredResponse(repaired.stdout);
    if (!repairedParsed) throw new ProviderNeedsHumanError('notebooklm_malformed_output');
    return { ...repairedParsed, prompts: [prompt, repairedPrompt] };
  }

  private async run(args: readonly string[], signal: AbortSignal, stdin?: string) {
    const response = await this.options.process.run({
      command: 'nlm',
      args,
      ...(stdin ? { stdin } : {}),
      timeoutMs: this.options.timeoutMs ?? DEFAULT_NOTEBOOKLM_TIMEOUT_MS,
      signal,
    });
    if (response.timedOut) {
      throw new ProviderWaitingError('notebooklm_timeout', new Date(this.now().getTime() + 60_000).toISOString());
    }
    return response;
  }

  private assertProcessSuccess(response: { stdout: string; stderr: string; exitCode: number | null }): void {
    if (response.exitCode === 0) return;
    const combined = `${response.stdout}\n${response.stderr}`;
    const cooldownSeconds = retryAfterSeconds(combined);
    if (/rate limit|cooldown|too many requests/i.test(combined)) {
      throw new ProviderWaitingError(
        'notebooklm_cooldown',
        new Date(this.now().getTime() + cooldownSeconds * 1_000).toISOString(),
      );
    }
    if (isDurableTransportConfigurationFailure(combined)) {
      throw new ProviderNeedsHumanError('notebooklm_transport_error');
    }
    if (isTemporaryTransportFailure(combined)) {
      throw new ProviderWaitingError(
        'notebooklm_transport_unavailable',
        new Date(this.now().getTime() + transportRetryAfterSeconds(combined) * 1_000).toISOString(),
      );
    }
    throw new ProviderNeedsHumanError('notebooklm_transport_error');
  }
}

interface NotebookLmResponseEnvelope {
  raw: string;
  conversationId: string;
  answer: unknown;
}

function parseResponseEnvelope(raw: string): NotebookLmResponseEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const envelope = parsed as Record<string, unknown>;
    const conversationId = typeof envelope.conversationId === 'string'
      ? envelope.conversationId
      : envelope.conversation_id;
    if (typeof conversationId !== 'string' || !conversationId.trim()) return null;
    return { raw, conversationId, answer: envelope.answer };
  } catch {
    return null;
  }
}

function parseStructuredResponse(raw: string): { raw: string; conversationId: string; answer: Record<string, unknown> } | null {
  const envelope = parseResponseEnvelope(raw);
  if (!envelope) return null;
  try {
    const answer = typeof envelope.answer === 'string' ? JSON.parse(envelope.answer) : envelope.answer;
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
    return { raw, conversationId: envelope.conversationId, answer: answer as Record<string, unknown> };
  } catch {
    return null;
  }
}

function renderMalformedOutputRepairPrompt(): string {
  return 'The prior answer was not valid JSON. Return the same answer again as one strict JSON object with no markdown fences.';
}

function researchCandidates(answer: Record<string, unknown>, sourceUrls: readonly string[]) {
  const directSources = Array.isArray(answer.sources) ? answer.sources : [];
  const candidates = directSources.flatMap((source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return [];
    const value = source as Record<string, unknown>;
    return typeof value.sourceId === 'string' && typeof value.title === 'string' && typeof value.url === 'string'
      ? [{ sourceId: value.sourceId, title: value.title, url: value.url }]
      : [];
  });
  if (candidates.length > 0) return candidates;

  // NotebookLM may return grounded numeric citation references without URLs.
  // In that shape, only URLs already attached to the run are eligible for verification.
  return [...new Set(sourceUrls)].map((url) => ({
    sourceId: `run-source-${createHash('sha256').update(url).digest('hex').slice(0, 16)}`,
    title: sourceTitle(url),
    url,
  }));
}

function sourceTitle(value: string): string {
  try {
    const url = new URL(value);
    return url.hostname.replace(/^www\./, '') + url.pathname.replace(/\/$/, '');
  } catch {
    return value;
  }
}

function resolvedCreateRecipes(context: NotebookLmContext): readonly ResolvedRecipe[] {
  const recipes = context.resolvedRecipes;
  const resolved = [recipes?.story, recipes?.playbook, recipes?.challenge];
  if (resolved.some((recipe) => !recipe)) {
    throw new ProviderNeedsHumanError('generation_recipe_resolution_missing');
  }
  return resolved as ResolvedRecipe[];
}

function renderRecipeCreatePrompt(
  context: NotebookLmContext,
  recipes: readonly ResolvedRecipe[],
): Uint8Array {
  if (!context.generationPlan || !context.evidence) {
    throw new ProviderNeedsHumanError('notebooklm_create_evidence_missing');
  }
  const promptInputs: PromptInputs = {
    topic: context.topic,
    locale: context.locale ?? 'en',
    audience: context.audience ?? 'general adult learners',
    objective: context.objective ?? context.topic,
    acceptedSourceIds: context.evidence.sources.map(({ sourceId }) => sourceId),
    ...(context.centralIdea ? { centralIdea: context.centralIdea } : {}),
  };
  return renderPromptSections([
    'Return one response encoded as a strict JSON object with no markdown fences.',
    `Named inputs:\n${JSON.stringify(promptInputs, null, 2)}`,
    `Output contract descriptor:\n${JSON.stringify(storyPlaybookDraftContractDescriptor, null, 2)}`,
    ...recipes.map((recipe) => [
      `Resolved recipe ${recipe.id}@${recipe.version} (canonical JSON):`,
      Buffer.from(recipe.canonicalBytes).toString('utf8'),
    ].join('\n')),
  ]);
}

function validateCitations(answer: Record<string, unknown>, acceptedEvidence?: EvidenceManifest): void {
  const claims = claimsFromAnswer(answer);
  const responseSources = Array.isArray(answer.sources)
    ? answer.sources.map((source) => source as { sourceId?: unknown }).map(({ sourceId }) => sourceId).filter((sourceId): sourceId is string => typeof sourceId === 'string')
    : [];
  const sourceIds = new Set(acceptedEvidence ? acceptedEvidence.sources.map((source) => source.sourceId) : responseSources);
  for (const claim of claims) {
    if (!Array.isArray(claim.citations)) throw new ProviderNeedsHumanError('notebooklm_citation_missing');
    for (const citation of claim.citations) {
      if (!citation || typeof citation.sourceId !== 'string' || !sourceIds.has(citation.sourceId)) {
        throw new ProviderNeedsHumanError('notebooklm_citation_source_missing');
      }
      if (typeof citation.excerpt !== 'string' || !citation.excerpt.trim()) {
        throw new ProviderNeedsHumanError('notebooklm_citation_excerpt_missing');
      }
    }
  }
}

function parseCreateOutput(
  answer: Record<string, unknown>,
  evidence: EvidenceManifest | undefined,
  generationPlan?: NugletGenerationPlan,
) {
  if (!evidence) throw new ProviderNeedsHumanError('notebooklm_create_evidence_missing');
  const snapshotsBySource = new Map(evidence.sources.map((source) => [source.sourceId, source.snapshotArtifactId]));
  if (generationPlan?.schemaVersion === '1.1.0') {
    const parsed = storyPlaybookDraftTargetSchema.safeParse(attachStoryPlaybookSnapshotArtifacts(answer, snapshotsBySource));
    if (!parsed.success) {
      throw new ProviderNeedsHumanError('notebooklm_content_invalid', 'quality');
    }
    return parsed.data;
  }

  const claims = attachSnapshotArtifacts(answer.claims, snapshotsBySource);
  const claimCoverage = normalizeClaimCoverage(answer.claimCoverage);
  const parsed = nugletLessonV1PayloadSchema.safeParse({ ...answer, claims, claimCoverage });
  if (!parsed.success) throw new ProviderNeedsHumanError('notebooklm_content_invalid', 'quality');
  return parsed.data;
}

const MAX_SEMANTIC_REPAIR_ISSUES = 20;
const MAX_SEMANTIC_REPAIR_ISSUE_CHARS = 2_000;

const SAFE_SEMANTIC_PATH_SEGMENTS = new Set([
  'kind', 'schemaVersion', 'payload', 'title', 'contentModel', 'materialization',
  'identity', 'locale', 'topic', 'label', 'categoryId', 'tags', 'deck', 'slugSuggestion',
  'learning', 'centralIdea', 'whyItMatters', 'oneLineToKeep', 'terminology', 'term', 'definition',
  'action', 'instruction', 'hero', 'altText', 'accessibilityPurpose', 'mediaBrief', 'concept',
  'metaphor', 'compositionFamily', 'read', 'story', 'playbook', 'estimatedMinutes', 'blocks',
  'type', 'text', 'claimRefs', 'principle', 'steps', 'id', 'body', 'example', 'watchOuts',
  'visual', 'textEquivalent', 'objective', 'structure', 'listen', 'brief', 'discussion',
  'editorialBrief', 'tone', 'keyPoints', 'quiz', 'questions', 'prompt', 'options', 'correctOptionId',
  'rationale', 'reviewConcept', 'publicSources', 'evidenceSourceId', 'publisher', 'claims', 'claimId',
  'statement', 'citations', 'sourceId', 'excerpt', 'snapshotArtifactId', 'claimCoverage', 'path', 'claimIds',
]);

const SAFE_SEMANTIC_MESSAGES_BY_PATH: Readonly<Record<string, string>> = {
  '$.kind': 'Expected "nuglet.lesson.v1".',
  '$.schemaVersion': 'Expected "1.1.0".',
  '$.payload.contentModel': 'Expected "story-playbook.v1".',
  '$.payload.materialization': 'Expected "draft".',
  '$.payload.hero.accessibilityPurpose': 'Expected one of the allowed values.',
};

const SAFE_SEMANTIC_MESSAGES_BY_CODE: Readonly<Record<string, string>> = {
  invalid_type: 'Expected the required value type.',
  invalid_literal: 'Expected the required constant value.',
  invalid_enum_value: 'Expected one of the allowed values.',
  unrecognized_keys: 'Remove fields that are not part of the contract.',
  invalid_union: 'Expected a value matching one allowed contract shape.',
  invalid_union_discriminator: 'Expected a valid contract discriminator.',
  invalid_arguments: 'Expected valid contract arguments.',
  invalid_return_type: 'Expected a valid contract result.',
  invalid_date: 'Expected a valid date.',
  invalid_string: 'Expected a value in the required string format.',
  too_small: 'Expected the required minimum length or count.',
  too_big: 'Expected no more than the allowed maximum.',
  invalid_intersection_types: 'Expected compatible contract values.',
  not_multiple_of: 'Expected a permitted numeric multiple.',
  not_finite: 'Expected a finite number.',
  custom: 'Value violates a contract relationship.',
};

function storyPlaybookSemanticIssues(answer: Record<string, unknown>, evidence: EvidenceManifest | undefined): string[] {
  if (!evidence) return ['$.payload: Accepted research evidence is required.'];
  const snapshotsBySource = new Map(evidence.sources.map((source) => [source.sourceId, source.snapshotArtifactId]));
  const parsed = storyPlaybookDraftTargetSchema.safeParse(attachStoryPlaybookSnapshotArtifacts(answer, snapshotsBySource));
  return parsed.success ? [] : safeSemanticIssues(parsed.error.issues);
}

function renderStoryPlaybookSemanticRepairPrompt(issues: readonly string[]): string {
  return [
    'The prior answer was structurally invalid. Preserve grounded meaning and accepted citations while correcting only the strict output contract.',
    'Return one strict JSON object with no markdown fences.',
    'Validation issues:',
    ...issues.map((issue) => `- ${issue}`),
    'Exact required root envelope:',
    '{ kind: "nuglet.lesson.v1", schemaVersion: "1.1.0", payload: { ... } }',
    `Output contract descriptor:\n${JSON.stringify(storyPlaybookDraftContractDescriptor, null, 2)}`,
  ].join('\n');
}

function safeSemanticIssues(issues: ReadonlyArray<{ code: string; path: readonly (string | number)[] }>): string[] {
  const rendered: string[] = [];
  let renderedChars = 0;
  for (const issue of issues) {
    if (rendered.length >= MAX_SEMANTIC_REPAIR_ISSUES) break;
    const path = safeZodIssuePath(issue.path);
    const message = SAFE_SEMANTIC_MESSAGES_BY_PATH[path]
      ?? SAFE_SEMANTIC_MESSAGES_BY_CODE[issue.code]
      ?? 'Value does not satisfy the contract.';
    const line = `${path}: ${message}`;
    const nextChars = renderedChars + 2 + line.length + (rendered.length > 0 ? 1 : 0);
    if (nextChars > MAX_SEMANTIC_REPAIR_ISSUE_CHARS) break;
    rendered.push(line);
    renderedChars = nextChars;
  }
  return rendered;
}

function safeZodIssuePath(path: readonly (string | number)[]): string {
  let rendered = '$';
  for (const part of path) {
    if (typeof part === 'number') {
      rendered += '[]';
      continue;
    }
    if (!SAFE_SEMANTIC_PATH_SEGMENTS.has(part)) {
      rendered += '.[field]';
      break;
    }
    rendered += `.${part}`;
  }
  return rendered;
}

function attachStoryPlaybookSnapshotArtifacts(
  answer: Record<string, unknown>,
  snapshotsBySource: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (!isRecord(answer.payload)) return answer;
  return {
    ...answer,
    payload: {
      ...answer.payload,
      claims: attachSnapshotArtifacts(answer.payload.claims, snapshotsBySource),
    },
  };
}

function attachSnapshotArtifacts(value: unknown, snapshotsBySource: ReadonlyMap<string, string>): unknown {
  return Array.isArray(value) ? value.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const claim = value as Record<string, unknown>;
    const citations = Array.isArray(claim.citations) ? claim.citations.map((citationValue) => {
      if (!citationValue || typeof citationValue !== 'object' || Array.isArray(citationValue)) return citationValue;
      const citation = citationValue as Record<string, unknown>;
      const snapshotArtifactId = typeof citation.sourceId === 'string'
        ? snapshotsBySource.get(citation.sourceId)
        : undefined;
      return { ...citation, snapshotArtifactId };
    }) : claim.citations;
    return { ...claim, citations };
  }) : value;
}

function normalizeClaimCoverage(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return value;
  return Object.entries(value).map(([path, claimIds]) => ({ path, claimIds }));
}

function sourceIds(answer: Record<string, unknown>): string[] {
  const direct = Array.isArray(answer.sources) ? answer.sources.flatMap((source) => {
    if (!source || typeof source !== 'object' || typeof (source as { sourceId?: unknown }).sourceId !== 'string') return [];
    return [(source as { sourceId: string }).sourceId];
  }) : [];
  const cited = claimsFromAnswer(answer).flatMap(({ citations }) => citations.map(({ sourceId }) => sourceId));
  return [...new Set([...direct, ...cited])];
}

function claimsFromAnswer(answer: Record<string, unknown>): GroundedClaim[] {
  const payload = isRecord(answer.payload) ? answer.payload : undefined;
  const claims = payload?.claims ?? answer.claims;
  return Array.isArray(claims) ? claims as GroundedClaim[] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function retryAfterSeconds(value: string): number {
  return parsedRetryAfterSeconds(value) ?? DEFAULT_NOTEBOOKLM_TRANSPORT_RETRY_SECONDS;
}

function transportRetryAfterSeconds(value: string): number {
  const retryAfter = parsedRetryAfterSeconds(value);
  return retryAfter !== undefined && retryAfter > 0 && retryAfter <= MAX_NOTEBOOKLM_TRANSPORT_RETRY_SECONDS
    ? retryAfter
    : DEFAULT_NOTEBOOKLM_TRANSPORT_RETRY_SECONDS;
}

function parsedRetryAfterSeconds(value: string): number | undefined {
  const match = /retry after\s+(\d+)\s*(?:seconds?|s)?/i.exec(value);
  return match ? Number(match[1]) : undefined;
}

function isTemporaryTransportFailure(value: string): boolean {
  return /\b(?:http\s*)?5(?:00|02|03|04)\b|bad gateway|gateway (?:error|timeout)|service unavailable|connection (?:reset|refused)|(?:temporary|transient) (?:dns|network|name resolution|failure)|(?:network|dns) (?:failure|error|unreachable)|socket hang ?up|eai[_ ]?again|econnreset|econnrefused|etimedout|timed? out|timeout/i.test(value);
}

function isDurableTransportConfigurationFailure(value: string): boolean {
  return /\b(?:auth(?:entication|orization)?|unauthori[sz]ed|forbidden|log ?in|credential|api[ _-]?key|token|notebook (?:not found|invalid)|invalid notebook|unknown notebook|no such notebook|command not found|missing (?:cli|command)|invalid (?:argument|option)|unknown option|usage:)\b/i.test(value);
}
