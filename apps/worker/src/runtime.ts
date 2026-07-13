import { spawn } from 'node:child_process';

import type { ContentCandidate, EvidenceManifest } from './checks/deterministic.js';
import { FixtureProvider } from './providers/fixture.js';
import { MediaProviderAdapter, type MediaClient } from './providers/media.js';
import { NotebookLmProvider, type NotebookLmContext, type NotebookLmProcess } from './providers/notebooklm.js';
import { PiEditorialProvider, type PiSdkClient } from './providers/pi.js';
import {
  ProviderNeedsHumanError,
  ProviderWaitingError,
  type ProviderExecution,
  type ProviderExecutionInput,
  type WorkerAction,
  type WorkerProvider,
} from './providers/types.js';

type NotebookContextResolver = (input: ProviderExecutionInput) => Promise<NotebookLmContext>;
type PiContextResolver = (input: ProviderExecutionInput) => Promise<{
  candidate: ContentCandidate;
  evidence: EvidenceManifest;
  rubric: string;
}>;
type MediaContextResolver = (input: ProviderExecutionInput) => Promise<{
  passedCheck: boolean;
  content: ContentCandidate;
  contentChecksum: string;
}>;

export interface ProviderRuntime {
  notebookProcess?: NotebookLmProcess;
  notebookContext?: NotebookContextResolver;
  piClient?: PiSdkClient;
  piContext?: PiContextResolver;
  mediaClient?: MediaClient;
  mediaContext?: MediaContextResolver;
}

export function composeWorkerProviders(options: {
  env?: NodeJS.ProcessEnv;
  runtime?: ProviderRuntime;
  fetch?: typeof fetch;
}): readonly WorkerProvider[] {
  const env = options.env ?? process.env;
  const mode = env.WORKER_PROVIDER_MODE?.trim() || 'production';
  if (mode === 'fixture') {
    return [new FixtureProvider({ fixtureDirectory: configuredValue(env, 'WORKER_FIXTURE_DIRECTORY') })];
  }
  if (mode !== 'production') {
    return [new UnavailableProvider('runtime', ['collect_sources', 'create_content', 'check_content', 'produce_assets'], 'provider_runtime_mode_invalid')];
  }

  const runtime = options.runtime ?? configuredRuntime(env, options.fetch ?? fetch);
  return [
    runtime.notebookProcess && runtime.notebookContext
      ? new NotebookLmProvider({ process: runtime.notebookProcess, context: runtime.notebookContext })
      : new UnavailableProvider('notebooklm', ['collect_sources', 'create_content']),
    runtime.piClient && runtime.piContext
      ? new PiEditorialProvider({ client: runtime.piClient, context: runtime.piContext })
      : new UnavailableProvider('pi', ['check_content']),
    runtime.mediaClient && runtime.mediaContext
      ? new MediaProviderAdapter({ client: runtime.mediaClient, context: runtime.mediaContext })
      : new UnavailableProvider('media', ['produce_assets']),
  ];
}

function configuredRuntime(env: NodeJS.ProcessEnv, request: typeof fetch): ProviderRuntime {
  const contextUrl = configuredValue(env, 'PROVIDER_CONTEXT_URL');
  const context = contextUrl ? new HttpProviderContextResolver({ url: contextUrl, token: configuredValue(env, 'PROVIDER_CONTEXT_TOKEN'), fetch: request }) : undefined;
  const piUrl = configuredValue(env, 'PI_EDITORIAL_URL');
  const mediaUrl = configuredValue(env, 'MEDIA_GENERATION_URL');

  return {
    ...(context ? {
      notebookProcess: new SpawnNotebookLmProcess(),
      notebookContext: (input) => context.notebook(input),
      piContext: (input) => context.pi(input),
      mediaContext: (input) => context.media(input),
    } : {}),
    ...(piUrl ? { piClient: new HttpPiSdkClient({ url: piUrl, token: configuredValue(env, 'PI_EDITORIAL_TOKEN'), fetch: request }) } : {}),
    ...(mediaUrl ? { mediaClient: new HttpMediaClient({ url: mediaUrl, token: configuredValue(env, 'MEDIA_GENERATION_TOKEN'), fetch: request }) } : {}),
  };
}

class UnavailableProvider implements WorkerProvider {
  readonly name: string;

  constructor(
    provider: string,
    readonly capabilities: readonly WorkerAction[],
    private readonly reason = `provider_runtime_unconfigured:${provider}`,
  ) {
    this.name = `${provider}-unavailable`;
  }

  async execute(_input: ProviderExecutionInput): Promise<ProviderExecution> {
    throw new ProviderNeedsHumanError(this.reason);
  }
}

class SpawnNotebookLmProcess implements NotebookLmProcess {
  async run(input: {
    command: string;
    args: readonly string[];
    stdin?: string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut?: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn(input.command, [...input.args], { stdio: ['pipe', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, input.timeoutMs);
      const abort = () => child.kill();
      input.signal.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.once('error', (error) => {
        clearTimeout(timeout);
        input.signal.removeEventListener('abort', abort);
        reject(error);
      });
      child.once('close', (exitCode) => {
        clearTimeout(timeout);
        input.signal.removeEventListener('abort', abort);
        resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode, timedOut });
      });
      if (input.stdin) child.stdin.write(input.stdin);
      child.stdin.end();
    });
  }
}

class HttpProviderContextResolver {
  constructor(private readonly options: { url: string; token?: string; fetch: typeof fetch }) {}

  async notebook(input: ProviderExecutionInput): Promise<NotebookLmContext> {
    return this.request('notebooklm', input) as Promise<NotebookLmContext>;
  }

  async pi(input: ProviderExecutionInput): Promise<Awaited<ReturnType<PiContextResolver>>> {
    return this.request('pi', input) as Promise<Awaited<ReturnType<PiContextResolver>>>;
  }

  async media(input: ProviderExecutionInput): Promise<Awaited<ReturnType<MediaContextResolver>>> {
    return this.request('media', input) as Promise<Awaited<ReturnType<MediaContextResolver>>>;
  }

  private async request(provider: string, input: ProviderExecutionInput): Promise<unknown> {
    const response = await this.options.fetch(this.options.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
      },
      body: JSON.stringify({ provider, action: input.action, job: input.job, idempotencyKey: input.idempotencyKey }),
      signal: input.signal,
    });
    if (response.status === 429 || response.status >= 500) {
      throw new ProviderWaitingError(`provider_context_unavailable:${provider}`, new Date(Date.now() + 60_000).toISOString());
    }
    if (!response.ok) throw new ProviderNeedsHumanError(`provider_context_invalid:${provider}`);
    return response.json();
  }
}

class HttpPiSdkClient implements PiSdkClient {
  constructor(private readonly options: { url: string; token?: string; fetch: typeof fetch }) {}

  async check(input: { candidate: ContentCandidate; evidence: EvidenceManifest; rubric: string }): Promise<unknown> {
    return postJson(this.options, input, 'pi_editorial_unavailable');
  }
}

class HttpMediaClient implements MediaClient {
  constructor(private readonly options: { url: string; token?: string; fetch: typeof fetch }) {}

  async generate(input: { content: ContentCandidate; inputChecksum: string; kinds: readonly ('hero' | 'infographic' | 'audio')[] }) {
    const response = await postJson(this.options, input, 'media_generation_unavailable');
    if (!response || typeof response !== 'object' || !Array.isArray((response as { assets?: unknown }).assets)) {
      throw new ProviderNeedsHumanError('media_generation_invalid_response');
    }
    return (response as { assets: unknown[] }).assets.map((asset) => parseMediaAsset(asset));
  }
}

async function postJson(
  options: { url: string; token?: string; fetch: typeof fetch },
  body: unknown,
  unavailableReason: string,
): Promise<unknown> {
  const response = await options.fetch(options.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (response.status === 429 || response.status >= 500) {
    throw new ProviderWaitingError(unavailableReason, new Date(Date.now() + 60_000).toISOString());
  }
  if (!response.ok) throw new ProviderNeedsHumanError(unavailableReason);
  return response.json();
}

function parseMediaAsset(value: unknown): { kind: 'hero' | 'infographic' | 'audio'; mediaType: string; bytes: Uint8Array; inputChecksum: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderNeedsHumanError('media_generation_invalid_response');
  const asset = value as Record<string, unknown>;
  if (
    (asset.kind !== 'hero' && asset.kind !== 'infographic' && asset.kind !== 'audio')
    || typeof asset.mediaType !== 'string'
    || !asset.mediaType.trim()
    || typeof asset.bytesBase64 !== 'string'
    || typeof asset.inputChecksum !== 'string'
  ) {
    throw new ProviderNeedsHumanError('media_generation_invalid_response');
  }
  const bytes = Buffer.from(asset.bytesBase64, 'base64');
  if (bytes.byteLength === 0) throw new ProviderNeedsHumanError('media_generation_invalid_response');
  return { kind: asset.kind, mediaType: asset.mediaType, bytes, inputChecksum: asset.inputChecksum };
}

function configuredValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}
