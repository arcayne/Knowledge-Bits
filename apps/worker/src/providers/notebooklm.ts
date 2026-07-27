import {
  NOTEBOOKLM_CREATE_PROMPT_VERSION,
  renderNotebookLmCreatePrompt,
} from '../prompts/notebooklm-create-legacy.v1.js';
import {
  NOTEBOOKLM_RESEARCH_PROMPT_VERSION,
  renderNotebookLmResearchPrompt,
} from '../prompts/notebooklm-research.v1.js';
import {
  runDeterministicChecks,
  type DeterministicFinding,
  type EvidenceManifest,
  type GroundedClaim,
} from '../checks/deterministic.js';
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
export const NOTEBOOKLM_QUERY_PROMPT_MAX_BYTES = 8_000;
export const NOTEBOOKLM_RECIPE_CREATE_PROMPT_VERSION = 'notebooklm-recipe-create.v1';
const DEFAULT_NOTEBOOKLM_TRANSPORT_RETRY_SECONDS = 60;
const MAX_NOTEBOOKLM_TRANSPORT_RETRY_SECONDS = 3_600;
const STORY_PLAYBOOK_CROSS_FORMAT_REQUIREMENTS = [
  'Cross-format requirements:',
  '- read.story and read.playbook must each contain the exact text of learning.centralIdea.',
  '- read.story and read.playbook must each contain the exact text of learning.oneLineToKeep.',
  '- read.story and read.playbook must each contain the exact text of learning.action.instruction.',
  '- read.story and read.playbook must each contain every learning.terminology term exactly.',
  '- read.playbook.action must equal learning.action.instruction exactly.',
  '- Story and Playbook must remain distinct and must not be normalized duplicates.',
].join('\n');

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

export type NotebookLmPhase =
  | 'cli_version'
  | 'source_sync'
  | 'research_query'
  | 'research_parse_or_repair'
  | 'research_verification'
  | 'create_query'
  | 'create_parse_or_repair'
  | 'story_query'
  | 'story_parse_or_repair'
  | 'playbook_query'
  | 'playbook_parse_or_repair'
  | 'semantic_repair';

export interface NotebookLmPhaseEvent {
  phase: NotebookLmPhase;
  status: 'started' | 'completed' | 'failed';
  at: string;
  durationMs?: number;
  error?: string;
}

interface NotebookLmPhaseTiming {
  phase: NotebookLmPhase;
  durationMs: number;
}

interface NotebookLmListedSource {
  sourceId: string;
  title: string;
  url: string;
  ready: boolean;
}

interface NotebookLmResearchSource {
  sourceId: string;
  title: string;
  url: string;
}

export class NotebookLmProvider implements ContentProvider {
  readonly name = 'notebooklm';
  readonly capabilities = ['collect_sources', 'create_content'] as const;
  private readonly now: () => Date;

  constructor(private readonly options: {
    process: NotebookLmProcess;
    context: (input: ProviderExecutionInput) => Promise<NotebookLmContext>;
    sourceVerifier?: ResearchSourceVerifier;
    separateReadQueries?: boolean;
    phaseReporter?: (event: NotebookLmPhaseEvent) => void;
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
    const promptBytes = input.action === 'collect_sources'
      ? renderPromptSections([renderNotebookLmResearchPrompt({ topic: context.topic })])
      : recipeExecution
        ? this.options.separateReadQueries
          ? renderRecipeStoryPrompt(context, recipeExecution)
          : renderRecipeCreatePrompt(context, recipeExecution)
        : renderPromptSections([renderNotebookLmCreatePrompt({
          topic: context.topic,
          revision: input.job.revision,
          sources: context.evidence?.sources,
        })]);
    const prompt = Buffer.from(promptBytes).toString('utf8');
    assertNotebookLmQueryPromptSize(prompt);
    const promptVersion = input.action === 'collect_sources'
      ? NOTEBOOKLM_RESEARCH_PROMPT_VERSION
      : recipeExecution
        ? NOTEBOOKLM_RECIPE_CREATE_PROMPT_VERSION
        : NOTEBOOKLM_CREATE_PROMPT_VERSION;
    const phaseTimings: NotebookLmPhaseTiming[] = [];
    const queryPhase: NotebookLmPhase = input.action === 'collect_sources'
      ? 'research_query'
      : recipeExecution && this.options.separateReadQueries
        ? 'story_query'
        : 'create_query';
    const parsePhase: NotebookLmPhase = input.action === 'collect_sources'
      ? 'research_parse_or_repair'
      : recipeExecution && this.options.separateReadQueries
        ? 'story_parse_or_repair'
        : 'create_parse_or_repair';
    const cliVersion = await this.runPhase('cli_version', phaseTimings, () => this.version(input.signal));
    const notebookSources = await this.runPhase('source_sync', phaseTimings, () => (
      this.synchronizeSources(context, input.signal, input.action === 'collect_sources')
    ));
    const response = await this.runPhase(queryPhase, phaseTimings, () => (
      this.query(context.notebookId, prompt, input.signal)
    ));
    let parsed = await this.runPhase(parsePhase, phaseTimings, () => (
      this.parseOrRepair(context.notebookId, prompt, response, input.signal)
    ));
    let rawResponse = parsed.raw;
    if (recipeExecution && this.options.separateReadQueries) {
      const playbookPrompt = renderRecipePlaybookPrompt(context, recipeExecution, parsed.answer);
      const playbookResponse = await this.runPhase('playbook_query', phaseTimings, () => this.query(
        context.notebookId,
        playbookPrompt,
        input.signal,
        parsed.conversationId,
      ));
      const playbookParsed = await this.runPhase('playbook_parse_or_repair', phaseTimings, () => this.parseOrRepair(
        context.notebookId,
        playbookPrompt,
        playbookResponse,
        input.signal,
      ));
      parsed = {
        raw: playbookParsed.raw,
        conversationId: playbookParsed.conversationId,
        answer: normalizeGroundedStoryPlaybookAnswer(
          normalizeStoryPlaybookAnswer(mergeStoryAndPlaybookAnswers(parsed.answer, playbookParsed.answer)),
          context.evidence,
        ),
        prompts: [...parsed.prompts, ...playbookParsed.prompts],
      };
      rawResponse = JSON.stringify({
        story: JSON.parse(response.stdout),
        playbook: JSON.parse(playbookResponse.stdout),
      });
    }
    if (input.action === 'create_content') validateCitations(parsed.answer, context.evidence);
    if (recipeExecution) {
      const issues = storyPlaybookSemanticIssues(parsed.answer, context.evidence);
      if (hasStoryPlaybookSemanticIssues(issues)) {
        const semanticRepairPrompt = renderStoryPlaybookSemanticRepairPrompt(issues);
        const repaired = await this.runPhase('semantic_repair', phaseTimings, async () => {
          const semanticRepairResponse = await this.query(
            context.notebookId,
            semanticRepairPrompt,
            input.signal,
            parsed.conversationId,
          );
          const semanticRepair = parseStructuredResponse(semanticRepairResponse.stdout);
          if (!semanticRepair) throw new ProviderNeedsHumanError('notebooklm_malformed_output');
          return semanticRepair;
        });
        parsed = {
          ...repaired,
          answer: normalizeGroundedStoryPlaybookAnswer(
            mergeSemanticRepairAnswer(parsed.answer, repaired.answer),
            context.evidence,
          ),
          prompts: [...parsed.prompts, semanticRepairPrompt],
        };
        validateCitations(parsed.answer, context.evidence);
        const remainingIssues = storyPlaybookSemanticIssues(parsed.answer, context.evidence);
        if (hasStoryPlaybookSemanticIssues(remainingIssues)) {
          if (!this.options.separateReadQueries) {
            throw new ProviderNeedsHumanError('notebooklm_content_invalid', 'quality');
          }
          const renderedPrompts = parsed.prompts;
          return {
            kind: 'needs_human',
            needsHumanKind: 'quality',
            reason: 'notebooklm_content_invalid',
            candidate: {
              rawResponse: Buffer.from(rawResponse),
              parsedOutput: parsed.answer,
              executionReport: {
                cliVersion,
                conversationId: parsed.conversationId,
                promptVersion,
                provider: this.name,
                renderedPrompt: prompt,
                renderedPrompts,
                sourceIds: sourceIds(parsed.answer),
                validationIssues: remainingIssues,
                reviewCandidate: true,
                phaseTimings,
              },
              supportArtifacts: renderedPrompts.flatMap((renderedPrompt) => recipeExecution.flatMap((recipe) => (
                generationSupportArtifacts({
                  recipe,
                  prompt: Buffer.from(renderedPrompt),
                  model: `notebooklm-cli:${cliVersion}`,
                  executionInput: input,
                })
              ))),
            },
          };
        }
      }
    }
    if (!this.options.separateReadQueries) rawResponse = parsed.raw;
    const verified = input.action === 'collect_sources'
      ? await this.runPhase('research_verification', phaseTimings, () => (
        this.verifyResearch(notebookSources, input.signal)
      ))
      : undefined;
    const parsedOutput = verified?.evidence
      ?? parseCreateOutput(parsed.answer, context.evidence, context.generationPlan);

    return {
      kind: 'success',
      rawResponse: Buffer.from(rawResponse),
      parsedOutput,
      executionReport: {
        cliVersion,
        conversationId: parsed.conversationId,
        promptVersion,
        provider: this.name,
        renderedPrompt: prompt,
        renderedPrompts: parsed.prompts,
        sourceIds: sourceIds(parsed.answer),
        phaseTimings,
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

  private async runPhase<T>(
    phase: NotebookLmPhase,
    timings: NotebookLmPhaseTiming[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = this.now();
    this.reportPhase({ phase, status: 'started', at: startedAt.toISOString() });
    try {
      const value = await operation();
      const completedAt = this.now();
      const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
      timings.push({ phase, durationMs });
      this.reportPhase({ phase, status: 'completed', at: completedAt.toISOString(), durationMs });
      return value;
    } catch (error) {
      const failedAt = this.now();
      this.reportPhase({
        phase,
        status: 'failed',
        at: failedAt.toISOString(),
        durationMs: Math.max(0, failedAt.getTime() - startedAt.getTime()),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private reportPhase(event: NotebookLmPhaseEvent): void {
    try {
      this.options.phaseReporter?.(event);
    } catch {
      // Observability must never change provider behavior.
    }
  }

  private async verifyResearch(
    notebookSources: readonly NotebookLmResearchSource[],
    signal: AbortSignal,
  ) {
    if (!this.options.sourceVerifier) throw new ProviderNeedsHumanError('source_verifier_unconfigured');
    const verified = await this.options.sourceVerifier.verify({ sources: notebookSources }, signal);
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

  private async synchronizeSources(
    context: NotebookLmContext,
    signal: AbortSignal,
    recordInventory: boolean,
  ): Promise<NotebookLmResearchSource[]> {
    if (context.sourceUrls.length === 0 && !recordInventory) return [];
    let existing = await this.listSources(context.notebookId, signal);
    const existingUrls = new Set(existing.map(({ url }) => url));
    const missing = [...new Set(context.sourceUrls)].filter((url) => !existingUrls.has(url));
    if (missing.length === 0) return recordInventory ? readyResearchSources(existing) : [];
    const response = await this.run(['source', 'add', context.notebookId, ...missing.flatMap((url) => ['--url', url]), '--wait'], signal);
    this.assertProcessSuccess(response);
    if (!recordInventory) return [];
    existing = await this.listSources(context.notebookId, signal);
    return readyResearchSources(existing);
  }

  private async listSources(notebookId: string, signal: AbortSignal): Promise<NotebookLmListedSource[]> {
    const response = await this.run(['source', 'list', notebookId, '--json'], signal);
    this.assertProcessSuccess(response);
    try {
      const parsed: unknown = JSON.parse(response.stdout);
      if (!Array.isArray(parsed)) throw new TypeError('source list is not an array');
      return parsed.flatMap(parseListedSource);
    } catch {
      throw new ProviderNeedsHumanError('notebooklm_source_list_invalid');
    }
  }

  private async query(notebookId: string, prompt: string, signal: AbortSignal, conversationId?: string) {
    assertNotebookLmQueryPromptSize(prompt);
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

function parseListedSource(value: unknown): NotebookLmListedSource[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const source = value as Record<string, unknown>;
  if (typeof source.url !== 'string' || source.url.length === 0) return [];
  const sourceId = stringField(source.id)
    ?? stringField(source.sourceId)
    ?? stringField(source.source_id)
    ?? `notebook-source-${createHash('sha256').update(source.url).digest('hex').slice(0, 16)}`;
  return [{
    sourceId,
    title: stringField(source.title) ?? sourceTitle(source.url),
    url: source.url,
    ready: listedSourceReady(source.status ?? source.state),
  }];
}

function readyResearchSources(sources: readonly NotebookLmListedSource[]): NotebookLmResearchSource[] {
  return sources.flatMap(({ ready, sourceId, title, url }) => (
    ready ? [{ sourceId, title, url }] : []
  ));
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function listedSourceReady(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (value === 2) return true;
  return typeof value === 'string' && /^(?:2|active|complete|completed|ready|success|succeeded)$/i.test(value.trim());
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

function renderRecipeStoryPrompt(
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
  const storyRecipe = recipes.find(({ id }) => id === 'nuglet.lesson.story');
  const challengeRecipe = recipes.find(({ id }) => id === 'nuglet.challenge');
  if (!storyRecipe || !challengeRecipe) {
    throw new ProviderNeedsHumanError('generation_recipe_resolution_missing');
  }
  return renderPromptSections([
    'Return one response encoded as a strict JSON object with no markdown fences.',
    'This is the Story query. Generate the shared lesson foundation, Story, challenge, citations, and media briefs.',
    'Do not generate read.playbook. The Playbook is requested separately after this response.',
    STORY_PLAYBOOK_CROSS_FORMAT_REQUIREMENTS,
    `Named inputs:\n${JSON.stringify(promptInputs)}`,
    `Output contract descriptor:\n${JSON.stringify(storyPlaybookDraftContractDescriptor)}`,
    ...[storyRecipe, challengeRecipe].map((recipe) => [
      `Resolved recipe ${recipe.id}@${recipe.version} (compact canonical JSON):`,
      compactCanonicalJson(recipe.canonicalBytes),
    ].join('\n')),
  ]);
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
    STORY_PLAYBOOK_CROSS_FORMAT_REQUIREMENTS,
    `Named inputs:\n${JSON.stringify(promptInputs)}`,
    `Output contract descriptor:\n${JSON.stringify(storyPlaybookDraftContractDescriptor)}`,
    ...recipes.map((recipe) => [
      `Resolved recipe ${recipe.id}@${recipe.version} (compact canonical JSON):`,
      compactCanonicalJson(recipe.canonicalBytes),
    ].join('\n')),
  ]);
}

function renderRecipePlaybookPrompt(
  context: NotebookLmContext,
  recipes: readonly ResolvedRecipe[],
  storyAnswer: Record<string, unknown>,
): string {
  const playbookRecipe = recipes.find(({ id }) => id === 'nuglet.lesson.playbook');
  if (!playbookRecipe) throw new ProviderNeedsHumanError('generation_recipe_resolution_missing');
  const payload = objectValue(storyAnswer.payload);
  const foundation = {
    topic: context.topic,
    learning: payload?.learning,
    claims: payload?.claims,
    acceptedSourceIds: context.evidence?.sources.map(({ sourceId }) => sourceId) ?? [],
  };
  const prompt = Buffer.from(renderPromptSections([
    'This is the separate Playbook query. Use the preceding Story response as context.',
    'Return one strict JSON object with no markdown fences in exactly this shape: {"playbook":{...}}.',
    'Generate only the Playbook. Do not regenerate Story, quiz, hero, visual, audio briefs, sources, or claims.',
    'Use only claim IDs already present in the Story response. Do not invent claims or source IDs.',
    STORY_PLAYBOOK_CROSS_FORMAT_REQUIREMENTS,
    `Shared foundation:\n${JSON.stringify(foundation)}`,
    `Required Playbook fields:\n${JSON.stringify(storyPlaybookDraftContractDescriptor.payloadShape.read.playbook)}`,
    `Resolved recipe ${playbookRecipe.id}@${playbookRecipe.version} (compact canonical JSON):\n${compactCanonicalJson(playbookRecipe.canonicalBytes)}`,
  ])).toString('utf8');
  assertNotebookLmQueryPromptSize(prompt);
  return prompt;
}

function mergeStoryAndPlaybookAnswers(
  storyAnswer: Record<string, unknown>,
  playbookAnswer: Record<string, unknown>,
): Record<string, unknown> {
  const wrappedStoryPayload = objectValue(storyAnswer.payload);
  const storyPayload = wrappedStoryPayload ?? storyPayloadCandidate(storyAnswer) ?? {
    read: { story: storyAnswer },
  };
  const storyRead = objectValue(storyPayload.read) ?? {};
  const directPlaybook = objectValue(playbookAnswer.playbook);
  const nestedPlaybook = objectValue(objectValue(playbookAnswer.read)?.playbook);
  const envelopePlaybook = objectValue(objectValue(objectValue(playbookAnswer.payload)?.read)?.playbook);
  const playbook = directPlaybook
    ?? nestedPlaybook
    ?? envelopePlaybook
    ?? playbookAnswer;
  return {
    ...(wrappedStoryPayload ? storyAnswer : {
      kind: 'nuglet.lesson.v1',
      schemaVersion: '1.1.0',
    }),
    payload: {
      ...storyPayload,
      read: {
        ...storyRead,
        playbook,
      },
    },
  };
}

function mergeSemanticRepairAnswer(
  previousAnswer: Record<string, unknown>,
  repairedAnswer: Record<string, unknown>,
): Record<string, unknown> {
  const previous = normalizeStoryPlaybookAnswer(previousAnswer);
  const repaired = normalizeStoryPlaybookAnswer(repairedAnswer);
  const previousPayload = objectValue(previous.payload);
  const repairedPayload = objectValue(repaired.payload);
  if (!previousPayload || !repairedPayload) return repaired;

  const previousRead = objectValue(previousPayload.read);
  const repairedRead = objectValue(repairedPayload.read);
  const previousPlaybook = objectValue(previousRead?.playbook);
  if (!previousPlaybook || objectValue(repairedRead?.playbook)) return repaired;

  return {
    ...repaired,
    payload: {
      ...repairedPayload,
      read: {
        ...repairedRead,
        playbook: previousPlaybook,
      },
    },
  };
}

function normalizeStoryPlaybookAnswer(answer: Record<string, unknown>): Record<string, unknown> {
  const payload = objectValue(answer.payload);
  if (!payload) return answer;
  const identity = objectValue(payload.identity);
  const topic = objectValue(identity?.topic);
  const topicLabel = typeof identity?.['topic.label'] === 'string' ? identity['topic.label'] : undefined;
  const topicCategoryId = typeof identity?.['topic.categoryId'] === 'string'
    ? identity['topic.categoryId']
    : undefined;
  const normalizedIdentity = identity && !topic && topicLabel && topicCategoryId
    ? Object.fromEntries(Object.entries({
      ...identity,
      topic: { label: topicLabel, categoryId: topicCategoryId },
    }).filter(([key]) => key !== 'topic.label' && key !== 'topic.categoryId'))
    : identity;
  const claimCoverage = Array.isArray(payload.claimCoverage)
    ? payload.claimCoverage.filter((entry) => {
      const candidate = objectValue(entry);
      return !Array.isArray(candidate?.claimIds) || candidate.claimIds.length > 0;
    })
    : payload.claimCoverage;

  return {
    ...answer,
    payload: {
      ...payload,
      ...(normalizedIdentity ? { identity: normalizedIdentity } : {}),
      ...(claimCoverage ? { claimCoverage } : {}),
    },
  };
}

function normalizeGroundedStoryPlaybookAnswer(
  answer: Record<string, unknown>,
  evidence: EvidenceManifest | undefined,
): Record<string, unknown> {
  const payload = objectValue(answer.payload);
  if (!payload || !evidence) return answer;

  const acceptedSourceIds = new Set(evidence.sources.map(({ sourceId }) => sourceId));
  const claims = Array.isArray(payload.claims) ? payload.claims.flatMap((value) => {
    const claim = objectValue(value);
    if (!claim || typeof claim.claimId !== 'string' || !Array.isArray(claim.citations)) return [];
    const citations = claim.citations.filter((value) => {
      const citation = objectValue(value);
      return citation
        && typeof citation.sourceId === 'string'
        && acceptedSourceIds.has(citation.sourceId)
        && typeof citation.excerpt === 'string'
        && citation.excerpt.trim().length > 0;
    });
    return citations.length > 0 ? [{ ...claim, citations }] : [];
  }) : payload.claims;
  if (!Array.isArray(claims)) return answer;

  const claimIds = new Set(claims.flatMap((value) => {
    const claim = objectValue(value);
    return claim && typeof claim.claimId === 'string' ? [claim.claimId] : [];
  }));
  const filterClaimRefs = (value: unknown): unknown => Array.isArray(value)
    ? value.filter((claimId): claimId is string => typeof claimId === 'string' && claimIds.has(claimId))
    : value;
  const normalizeClaimRefList = (values: unknown): unknown => Array.isArray(values)
    ? values.map((value) => {
      const item = objectValue(value);
      return item ? { ...item, claimRefs: filterClaimRefs(item.claimRefs) } : value;
    })
    : values;

  const read = objectValue(payload.read);
  const story = objectValue(read?.story);
  const playbook = objectValue(read?.playbook);
  const example = objectValue(playbook?.example);
  const visual = objectValue(payload.visual);
  const quiz = objectValue(payload.quiz);
  const claimCoverage = Array.isArray(payload.claimCoverage) ? payload.claimCoverage.flatMap((value) => {
    const coverage = objectValue(value);
    if (!coverage) return [];
    const filtered = filterClaimRefs(coverage.claimIds);
    return Array.isArray(filtered) && filtered.length > 0 ? [{ ...coverage, claimIds: filtered }] : [];
  }) : payload.claimCoverage;

  return {
    ...answer,
    payload: {
      ...payload,
      claims,
      claimCoverage,
      ...(read ? {
        read: {
          ...read,
          ...(story ? { story: { ...story, blocks: normalizeClaimRefList(story.blocks) } } : {}),
          ...(playbook ? {
            playbook: {
              ...playbook,
              steps: normalizeClaimRefList(playbook.steps),
              ...(example ? { example: { ...example, claimRefs: filterClaimRefs(example.claimRefs) } } : {}),
            },
          } : {}),
        },
      } : {}),
      ...(visual ? { visual: { ...visual, claimRefs: filterClaimRefs(visual.claimRefs) } } : {}),
      ...(quiz ? { quiz: { ...quiz, questions: normalizeClaimRefList(quiz.questions) } } : {}),
    },
  };
}

function storyPayloadCandidate(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const read = objectValue(value.read);
  if (objectValue(read?.story)) return value;

  const story = objectValue(value.story);
  if (!story) return undefined;
  return {
    ...value,
    read: {
      ...read,
      story,
    },
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function compactCanonicalJson(bytes: Uint8Array): string {
  return JSON.stringify(JSON.parse(Buffer.from(bytes).toString('utf8')));
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

const SAFE_DETERMINISTIC_MESSAGES_BY_CODE: Readonly<Record<DeterministicFinding['code'], string>> = {
  placeholder: 'Remove placeholders and internal metadata labels from learner-facing content.',
  'duplicate-depth': 'Keep each learner depth distinct.',
  'story-integrity': 'Include the required narrative arc and evidence-bound factual block.',
  'playbook-structure': 'Include the required principle, steps, example, watch-outs, and shared action.',
  'cross-format-consistency': 'Apply every cross-format requirement below while keeping Story and Playbook distinct.',
  'challenge-shape': 'Return exactly three valid application questions.',
  'citation-source': 'Bind every factual claim to accepted evidence.',
  'citation-excerpt': 'Give every citation a non-empty excerpt.',
  'content-shape': 'Supply every required learner-facing field.',
  'claim-inventory': 'Supply at least one supported claim.',
  'claim-coverage': 'Give every declared learner path and nested factual reference valid claim coverage.',
};

interface StoryPlaybookSemanticIssues {
  validation: readonly string[];
  deterministic: readonly string[];
}

function storyPlaybookSemanticIssues(
  answer: Record<string, unknown>,
  evidence: EvidenceManifest | undefined,
): StoryPlaybookSemanticIssues {
  if (!evidence) {
    return {
      validation: ['$.payload: Accepted research evidence is required.'],
      deterministic: [],
    };
  }
  const snapshotsBySource = new Map(evidence.sources.map((source) => [source.sourceId, source.snapshotArtifactId]));
  const parsed = storyPlaybookDraftTargetSchema.safeParse(attachStoryPlaybookSnapshotArtifacts(answer, snapshotsBySource));
  if (!parsed.success) {
    return {
      validation: safeSemanticIssues(parsed.error.issues),
      deterministic: [],
    };
  }
  return {
    validation: [],
    deterministic: safeDeterministicIssues(runDeterministicChecks({
      candidate: parsed.data,
      evidence,
    }).findings),
  };
}

function hasStoryPlaybookSemanticIssues(issues: StoryPlaybookSemanticIssues): boolean {
  return issues.validation.length > 0 || issues.deterministic.length > 0;
}

function renderStoryPlaybookSemanticRepairPrompt(issues: StoryPlaybookSemanticIssues): string {
  return [
    'The prior answer was structurally invalid. Preserve grounded meaning and accepted citations while correcting only the strict output contract.',
    'Return one strict JSON object with no markdown fences.',
    'Validation issues:',
    ...(issues.validation.length > 0 ? issues.validation : ['None.']).map((issue) => `- ${issue}`),
    'Exact required root envelope:',
    '{ kind: "nuglet.lesson.v1", schemaVersion: "1.1.0", payload: { ... } }',
    'Deterministic findings:',
    ...(issues.deterministic.length > 0 ? issues.deterministic : ['None.']).map((issue) => `- ${issue}`),
    STORY_PLAYBOOK_CROSS_FORMAT_REQUIREMENTS,
    `Output contract descriptor:\n${JSON.stringify(storyPlaybookDraftContractDescriptor)}`,
  ].join('\n');
}

function assertNotebookLmQueryPromptSize(prompt: string): void {
  if (Buffer.byteLength(prompt, 'utf8') > NOTEBOOKLM_QUERY_PROMPT_MAX_BYTES) {
    throw new ProviderNeedsHumanError('notebooklm_prompt_too_large');
  }
}

function safeDeterministicIssues(findings: readonly DeterministicFinding[]): string[] {
  const rendered: string[] = [];
  const seen = new Set<DeterministicFinding['code']>();
  let renderedChars = 0;
  for (const { code } of findings) {
    if (seen.has(code) || rendered.length >= MAX_SEMANTIC_REPAIR_ISSUES) continue;
    const line = `$.deterministic.${code}: ${SAFE_DETERMINISTIC_MESSAGES_BY_CODE[code]}`;
    const nextChars = renderedChars + 2 + line.length + (rendered.length > 0 ? 1 : 0);
    if (nextChars > MAX_SEMANTIC_REPAIR_ISSUE_CHARS) break;
    seen.add(code);
    rendered.push(line);
    renderedChars = nextChars;
  }
  return rendered;
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
