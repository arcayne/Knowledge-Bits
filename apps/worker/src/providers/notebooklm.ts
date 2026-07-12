import {
  NOTEBOOKLM_CREATE_PROMPT_VERSION,
  renderNotebookLmCreatePrompt,
} from '../prompts/notebooklm-create.v1.js';
import {
  NOTEBOOKLM_RESEARCH_PROMPT_VERSION,
  renderNotebookLmResearchPrompt,
} from '../prompts/notebooklm-research.v1.js';
import type { EvidenceManifest, GroundedClaim } from '../checks/deterministic.js';

import {
  ProviderNeedsHumanError,
  ProviderWaitingError,
  type ContentProvider,
  type ProviderExecution,
  type ProviderExecutionInput,
} from './types.js';

const TIMEOUT_MS = 90_000;

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
}

export class NotebookLmProvider implements ContentProvider {
  readonly name = 'notebooklm';
  readonly capabilities = ['collect_sources', 'create_content'] as const;
  private readonly now: () => Date;

  constructor(private readonly options: {
    process: NotebookLmProcess;
    context: (input: ProviderExecutionInput) => Promise<NotebookLmContext>;
    now?: () => Date;
    timeoutMs?: number;
  }) {
    this.now = options.now ?? (() => new Date());
  }

  async execute(input: ProviderExecutionInput): Promise<ProviderExecution> {
    if (input.action !== 'collect_sources' && input.action !== 'create_content') {
      throw new ProviderNeedsHumanError(`notebooklm_unsupported_action:${input.action}`);
    }
    if (input.action === 'create_content' && input.job.revision > 3) {
      throw new ProviderNeedsHumanError('notebooklm_revision_limit');
    }

    const context = await this.options.context(input);
    const cliVersion = await this.version(input.signal);
    await this.importSources(context, input.signal);
    const prompt = input.action === 'collect_sources'
      ? renderNotebookLmResearchPrompt({ topic: context.topic })
      : renderNotebookLmCreatePrompt({ topic: context.topic, revision: input.job.revision });
    const promptVersion = input.action === 'collect_sources'
      ? NOTEBOOKLM_RESEARCH_PROMPT_VERSION
      : NOTEBOOKLM_CREATE_PROMPT_VERSION;
    const response = await this.query(context.notebookId, prompt, input.signal);
    const parsed = await this.parseOrRepair(context.notebookId, prompt, response, input.signal);
    validateCitations(parsed.answer, context.evidence);
    const parsedOutput = input.action === 'collect_sources' ? markSourceCandidates(parsed.answer) : parsed.answer;

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
    };
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
    const response = await this.run(['source', 'add', context.notebookId, ...context.sourceUrls.flatMap((url) => ['--url', url]), '--wait'], signal);
    this.assertProcessSuccess(response);
  }

  private async query(notebookId: string, prompt: string, signal: AbortSignal) {
    const response = await this.run(['notebook', 'query', notebookId, '--json'], signal, prompt);
    this.assertProcessSuccess(response);
    return response;
  }

  private async parseOrRepair(
    notebookId: string,
    prompt: string,
    response: { stdout: string; stderr: string; exitCode: number | null; timedOut?: boolean },
    signal: AbortSignal,
  ): Promise<{ raw: string; conversationId: string; answer: Record<string, unknown> }> {
    const parsed = parseStructuredResponse(response.stdout);
    if (parsed) return parsed;

    const repaired = await this.run(['notebook', 'query', notebookId, '--json', '--repair-json'], signal, prompt);
    this.assertProcessSuccess(repaired);
    const repairedParsed = parseStructuredResponse(repaired.stdout);
    if (!repairedParsed) throw new ProviderNeedsHumanError('notebooklm_malformed_output');
    return repairedParsed;
  }

  private async run(args: readonly string[], signal: AbortSignal, stdin?: string) {
    const response = await this.options.process.run({
      command: 'nlm',
      args,
      ...(stdin ? { stdin } : {}),
      timeoutMs: this.options.timeoutMs ?? TIMEOUT_MS,
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
    if (typeof envelope.conversationId !== 'string' || !envelope.conversationId.trim()) return null;
    const answer = typeof envelope.answer === 'string' ? JSON.parse(envelope.answer) : envelope.answer;
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
    return { raw, conversationId: envelope.conversationId, answer: answer as Record<string, unknown> };
  } catch {
    return null;
  }
}

function validateCitations(answer: Record<string, unknown>, evidence?: EvidenceManifest): void {
  const claims = Array.isArray(answer.claims) ? answer.claims as GroundedClaim[] : [];
  const responseSources = Array.isArray(answer.sources)
    ? answer.sources.map((source) => source as { sourceId?: unknown }).map(({ sourceId }) => sourceId).filter((sourceId): sourceId is string => typeof sourceId === 'string')
    : [];
  const sourceIds = new Set([...responseSources, ...(evidence?.sources.map((source) => source.sourceId) ?? [])]);
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

function sourceIds(answer: Record<string, unknown>): string[] {
  if (!Array.isArray(answer.sources)) return [];
  return answer.sources.flatMap((source) => {
    if (!source || typeof source !== 'object' || typeof (source as { sourceId?: unknown }).sourceId !== 'string') return [];
    return [(source as { sourceId: string }).sourceId];
  });
}

function markSourceCandidates(answer: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(answer.sources)) return answer;
  return {
    ...answer,
    sources: answer.sources.map((source) => ({
      ...(source && typeof source === 'object' && !Array.isArray(source) ? source : {}),
      status: 'candidate',
    })),
  };
}

function retryAfterSeconds(value: string): number {
  const match = /retry after\s+(\d+)\s*(?:seconds?|s)?/i.exec(value);
  return match ? Number(match[1]) : 60;
}
