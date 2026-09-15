import { createHash } from 'node:crypto';

import { ProviderNeedsHumanError, ProviderWaitingError } from './types.js';
import type { ResearchSourceCandidate, ResearchSourceDiscoveryClient, ResearchSourceDiscoveryResult } from './source-discovery.js';

interface ResearchProcess {
  run(input: {
    command: string;
    args: readonly string[];
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut?: boolean }>;
}

interface YouTubeOEmbed {
  title?: string;
  author_name?: string;
}

export class NotebookLmResearchSourceDiscoveryClient implements ResearchSourceDiscoveryClient {
  constructor(private readonly options: {
    process: ResearchProcess;
    command?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    mode?: 'fast' | 'deep';
  }) {}

  async discoverSources(input: Parameters<ResearchSourceDiscoveryClient['discoverSources']>[0]): Promise<ResearchSourceDiscoveryResult> {
    const metadata = await this.youtubeMetadata(input.seedUrls, input.signal);
    const query = renderResearchQuery(input, metadata);
    const started = await this.run([
      'research', 'start', query,
      '--source', 'web',
      '--mode', this.options.mode ?? 'fast',
      '--notebook-id', input.notebookId,
    ], input.signal);
    assertSuccess(started, 'notebooklm_research_start');
    const taskId = parseTaskId(started.stdout);
    if (!taskId) throw new ProviderNeedsHumanError('notebooklm_research_task_id_missing');

    const status = await this.run([
      'research', 'status', input.notebookId,
      '--task-id', taskId,
      '--max-wait', String(Math.max(1, Math.ceil((this.options.timeoutMs ?? 180_000) / 1_000))),
      '--poll-interval', '5',
      '--full',
    ], input.signal);
    assertSuccess(status, 'notebooklm_research_status');
    const candidates = parseDiscoveredSources(status.stdout, input.maxCandidates, query);
    if (candidates.length === 0) throw new ProviderNeedsHumanError('notebooklm_research_no_sources', 'quality');
    return {
      candidates,
      report: {
        schemaVersion: 'research-source-discovery.v1',
        provider: 'notebooklm-research',
        model: 'notebooklm-web-research',
        topic: metadata?.title ?? input.topic,
        seedSourceCount: input.seedUrls.length,
        requestedCandidateCount: input.maxCandidates,
        returnedCandidateCount: candidates.length,
      },
    };
  }

  private async run(args: readonly string[], signal: AbortSignal) {
    return this.options.process.run({
      command: this.options.command ?? 'nlm',
      args,
      timeoutMs: this.options.timeoutMs ?? 180_000,
      signal,
    });
  }

  private async youtubeMetadata(seedUrls: readonly string[], signal: AbortSignal): Promise<YouTubeOEmbed | undefined> {
    const youtubeUrl = seedUrls.find(isYouTubeUrl);
    const request = this.options.fetch ?? fetch;
    if (!youtubeUrl) return undefined;
    try {
      const timeout = AbortSignal.timeout(10_000);
      const response = await request(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(youtubeUrl)}&format=json`,
        { signal: AbortSignal.any([signal, timeout]) },
      );
      if (!response.ok) return undefined;
      const value = await response.json() as unknown;
      if (!isRecord(value)) return undefined;
      return {
        ...(typeof value.title === 'string' && value.title.trim() ? { title: value.title.trim() } : {}),
        ...(typeof value.author_name === 'string' && value.author_name.trim() ? { author_name: value.author_name.trim() } : {}),
      };
    } catch {
      return undefined;
    }
  }
}

function renderResearchQuery(
  input: Parameters<ResearchSourceDiscoveryClient['discoverSources']>[0],
  metadata: YouTubeOEmbed | undefined,
): string {
  const title = metadata?.title ?? input.topic;
  const author = metadata?.author_name ? ` by ${metadata.author_name}` : '';
  return [
    `Find authoritative sources related to the YouTube video "${title}"${author}.`,
    `Video source: ${input.seedUrls.find(isYouTubeUrl) ?? 'not provided'}.`,
    `Topic context: ${input.topic}.`,
    `Research objective: ${input.objective}.`,
    `Audience: ${input.audience}.`,
    'Find academic papers, technical reports, official documentation, and primary sources that add useful context beyond the video.',
    'Focus on the video\'s main technical claims and topics.',
    'Exclude duplicate versions of the video, promotional pages, SEO summaries, and low-quality sources.',
  ].join('\n');
}

function parseTaskId(stdout: string): string | undefined {
  return stdout.match(/Task ID:\s*([\w-]+)/i)?.[1];
}

function parseDiscoveredSources(stdout: string, maximum: number, rationale: string): ResearchSourceCandidate[] {
  const lines = stdout.split(/\r?\n/);
  const candidates: ResearchSourceCandidate[] = [];
  let title = '';
  for (const line of lines) {
    const indexed = line.match(/^\s*\[(\d+)\]\s+(.*)$/);
    if (indexed) {
      title = indexed[2].trim();
      continue;
    }
    const url = line.trim().match(/^https?:\/\/\S+$/)?.[0];
    if (url && title) {
      candidates.push({
        sourceId: `nlm-research-${createHash('sha256').update(url).digest('hex').slice(0, 16)}`,
        title: title.replace(/\s+/g, ' '),
        url,
        sourceType: 'notebooklm-web-research',
        rationale,
      });
      title = '';
      if (candidates.length >= maximum) break;
      continue;
    }
    if (title && line.trim() && !/^[-=]+$/.test(line.trim())) {
      title = `${title} ${line.trim()}`;
    }
  }
  return candidates;
}

function assertSuccess(response: { stdout: string; stderr: string; exitCode: number | null; timedOut?: boolean }, operation: string): void {
  if (response.timedOut) {
    throw new ProviderWaitingError(`${operation}_timeout`, new Date(Date.now() + 60_000).toISOString());
  }
  if (response.exitCode === 0) return;
  const message = `${response.stdout}\n${response.stderr}`;
  if (/rate limit|cooldown|too many requests|timeout/i.test(message)) {
    throw new ProviderWaitingError(`${operation}_unavailable`, new Date(Date.now() + 60_000).toISOString());
  }
  if (/auth|credential|login|forbidden|unauthori[sz]ed|command not found|missing/i.test(message)) {
    throw new ProviderNeedsHumanError(`${operation}_configuration`);
  }
  throw new ProviderNeedsHumanError(`${operation}_failed`);
}

function isYouTubeUrl(value: string): boolean {
  try {
    return ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
