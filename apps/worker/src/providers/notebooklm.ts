import {
  NOTEBOOKLM_CREATE_PROMPT_VERSION,
  renderNotebookLmCreatePrompt,
} from '../prompts/notebooklm-create.v1.js';
import {
  NOTEBOOKLM_RESEARCH_PROMPT_VERSION,
  renderNotebookLmResearchPrompt,
} from '../prompts/notebooklm-research.v1.js';
import type { EvidenceManifest, GroundedClaim } from '../checks/deterministic.js';
import type { VerifiedResearchEvidence } from '../checks/source-verifier.js';
import { nugletLessonV1PayloadSchema, type NugletGenerationPlan } from '@knowledge-bits/contracts';
import { renderPromptSections } from '../recipes/file-registry.js';
import { generationSupportArtifacts } from '../recipes/support-artifacts.js';
import type { ResolvedNugletRecipes } from '../recipes/types.js';

import {
  ProviderNeedsHumanError,
  ProviderWaitingError,
  type ContentProvider,
  type ProviderExecution,
  type ProviderExecutionInput,
} from './types.js';
import { createHash } from 'node:crypto';

export const DEFAULT_NOTEBOOKLM_TIMEOUT_MS = 180_000;

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
    const cliVersion = await this.version(input.signal);
    await this.importSources(context, input.signal);
    const basePrompt = input.action === 'collect_sources'
      ? renderNotebookLmResearchPrompt({ topic: context.topic })
      : renderNotebookLmCreatePrompt({
        topic: context.topic,
        revision: input.job.revision,
        sources: context.evidence?.sources,
      });
    const recipe = context.generationPlan ? context.resolvedRecipes?.story : undefined;
    if (context.generationPlan && !recipe) throw new ProviderNeedsHumanError('generation_recipe_resolution_missing');
    const promptBytes = recipe
      ? renderPromptSections([
        basePrompt,
        'Resolved generation recipe (canonical JSON):',
        Buffer.from(recipe.canonicalBytes).toString('utf8'),
      ])
      : renderPromptSections([basePrompt]);
    const prompt = Buffer.from(promptBytes).toString('utf8');
    const promptVersion = input.action === 'collect_sources'
      ? NOTEBOOKLM_RESEARCH_PROMPT_VERSION
      : NOTEBOOKLM_CREATE_PROMPT_VERSION;
    const response = await this.query(context.notebookId, prompt, input.signal);
    const parsed = await this.parseOrRepair(context.notebookId, prompt, response, input.signal);
    validateCitations(parsed.answer, input.action === 'create_content' ? context.evidence : undefined);
    const verified = input.action === 'collect_sources'
      ? await this.verifyResearch(parsed.answer, context, input.signal)
      : undefined;
    const parsedOutput = verified?.evidence
      ?? parseCreateOutput(parsed.answer, context.evidence);

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
        sourceIds: sourceIds(parsed.answer),
      },
      ...(recipe ? {
        supportArtifacts: parsed.prompts.flatMap((renderedPrompt) => generationSupportArtifacts({
          recipe,
          prompt: Buffer.from(renderedPrompt),
          model: `notebooklm-cli:${cliVersion}`,
          executionInput: input,
        })),
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

  private async query(notebookId: string, prompt: string, signal: AbortSignal) {
    const response = await this.run(['notebook', 'query', notebookId, prompt, '--json'], signal);
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

    const repairedPrompt = `${prompt}\n\nReturn the same answer again as one strict JSON object with no markdown fences.`;
    const repaired = await this.run(['notebook', 'query', notebookId, repairedPrompt, '--json'], signal);
    this.assertProcessSuccess(repaired);
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
    throw new ProviderNeedsHumanError('notebooklm_transport_error');
  }
}

function parseStructuredResponse(raw: string): { raw: string; conversationId: string; answer: Record<string, unknown> } | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const envelope = parsed as Record<string, unknown>;
    const conversationId = typeof envelope.conversationId === 'string'
      ? envelope.conversationId
      : envelope.conversation_id;
    if (typeof conversationId !== 'string' || !conversationId.trim()) return null;
    const answer = typeof envelope.answer === 'string' ? JSON.parse(envelope.answer) : envelope.answer;
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
    return { raw, conversationId, answer: answer as Record<string, unknown> };
  } catch {
    return null;
  }
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

function validateCitations(answer: Record<string, unknown>, acceptedEvidence?: EvidenceManifest): void {
  const claims = Array.isArray(answer.claims) ? answer.claims as GroundedClaim[] : [];
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

function parseCreateOutput(answer: Record<string, unknown>, evidence: EvidenceManifest | undefined) {
  if (!evidence) throw new ProviderNeedsHumanError('notebooklm_create_evidence_missing');
  const snapshotsBySource = new Map(evidence.sources.map((source) => [source.sourceId, source.snapshotArtifactId]));
  const claims = Array.isArray(answer.claims) ? answer.claims.map((value) => {
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
  }) : answer.claims;
  const claimCoverage = normalizeClaimCoverage(answer.claimCoverage);
  const parsed = nugletLessonV1PayloadSchema.safeParse({ ...answer, claims, claimCoverage });
  if (!parsed.success) throw new ProviderNeedsHumanError('notebooklm_content_invalid', 'quality');
  return parsed.data;
}

function normalizeClaimCoverage(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return value;
  return Object.entries(value).map(([path, claimIds]) => ({ path, claimIds }));
}

function sourceIds(answer: Record<string, unknown>): string[] {
  if (!Array.isArray(answer.sources)) return [];
  return answer.sources.flatMap((source) => {
    if (!source || typeof source !== 'object' || typeof (source as { sourceId?: unknown }).sourceId !== 'string') return [];
    return [(source as { sourceId: string }).sourceId];
  });
}

function retryAfterSeconds(value: string): number {
  const match = /retry after\s+(\d+)\s*(?:seconds?|s)?/i.exec(value);
  return match ? Number(match[1]) : 60;
}
