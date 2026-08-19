import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  knowledgeBitsRunBriefSchema,
  knowledgeBitsQaSchema,
  nugletGenerationPlanSchema,
  nugletLessonV1PayloadSchema,
  storyPlaybookDraftSchema,
  type NugletGenerationPlan,
  type NugletMediaBaseline,
} from '@knowledge-bits/contracts';
import { calculateContentChecksum } from '@knowledge-bits/pipeline';

import { parseProductRecipeRoots } from './config.js';
import type { ContentCandidate, EvidenceManifest } from './checks/deterministic.js';
import { DeterministicSourceVerifier, publicUrlRejectionReason } from './checks/source-verifier.js';
import type { WorkerEngineClient } from './engine-client.js';
import { FixtureProvider } from './providers/fixture.js';
import {
  MediaProviderAdapter,
  recipeForKind,
  type GeneratedMedia,
  type MediaClient,
  type MediaKind,
  type MediaOperation,
  type SelectedMediaRecipes,
} from './providers/media.js';
import { generationSupportArtifacts } from './recipes/support-artifacts.js';
import { NotebookLmProvider, type NotebookLmContext, type NotebookLmProcess, type ResearchSourceVerifier } from './providers/notebooklm.js';
import { NotebookLmNotebookProvisioner } from './providers/notebooklm-provisioner.js';
import {
  PiEditorialProvider,
  type PiSdkClient,
} from './providers/pi.js';
import type {
  ResearchSourceCandidate,
  ResearchSourceDiscoveryClient,
  ResearchSourceDiscoveryResult,
} from './providers/source-discovery.js';
import {
  ProviderNeedsHumanError,
  ProviderWaitingError,
  type ProviderExecution,
  type ProviderExecutionInput,
  type WorkerAction,
  type WorkerProvider,
} from './providers/types.js';
import { FileRecipeRegistry } from './recipes/file-registry.js';
import type {
  NugletRecipeRole,
  RecipeBinding,
  ResolvedNugletRecipes,
  ResolvedRecipe,
} from './recipes/types.js';

type NotebookContextResolver = (input: ProviderExecutionInput) => Promise<NotebookLmContext>;
type PiContextResolver = (input: ProviderExecutionInput) => Promise<{
  candidate: ContentCandidate;
  evidence: EvidenceManifest;
  rubric: string;
  generationPlan?: NugletGenerationPlan;
  resolvedRecipes?: Partial<ResolvedNugletRecipes>;
}>;
type MediaContextResolver = (input: ProviderExecutionInput) => Promise<{
  passedCheck: boolean;
  content: ContentCandidate;
  contentChecksum: string;
  generationPlan?: NugletGenerationPlan;
  resolvedRecipes?: Partial<ResolvedNugletRecipes>;
  legacyMediaReuse?: unknown;
  mediaKinds?: readonly MediaKind[];
  mediaOperation?: MediaOperation;
}>;

export interface TrustedRecipeBindingVerifier {
  resolve?(binding: RecipeBinding): ResolvedRecipe | Promise<ResolvedRecipe>;
  resolvePlan(plan: NugletGenerationPlan): ResolvedNugletRecipes | Promise<ResolvedNugletRecipes>;
}

export interface ProviderRuntime {
  recipeBindingVerifier?: TrustedRecipeBindingVerifier;
  notebookProcess?: NotebookLmProcess;
  notebookContext?: NotebookContextResolver;
  sourceVerifier?: ResearchSourceVerifier;
  sourceDiscoverer?: ResearchSourceDiscoveryClient;
  piClient?: PiSdkClient;
  piContext?: PiContextResolver;
  mediaClient?: MediaClient;
  mediaContext?: MediaContextResolver;
  configurationIssues?: Partial<Record<'notebooklm' | 'pi' | 'media', string>>;
}

export function composeWorkerProviders(options: {
  env?: NodeJS.ProcessEnv;
  runtime?: ProviderRuntime;
  engineClient?: WorkerEngineClient;
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

  const runtime = options.runtime ?? configuredRuntime(env, options.engineClient, options.fetch ?? fetch);
  return [
    runtime.notebookProcess && runtime.notebookContext && runtime.sourceVerifier
      ? new NotebookLmProvider({
        process: runtime.notebookProcess,
        command: configuredValue(env, 'NOTEBOOKLM_COMMAND') ?? 'nlm',
        context: trustedContextResolver(runtime.notebookContext, runtime.recipeBindingVerifier),
        sourceVerifier: runtime.sourceVerifier,
        ...(runtime.sourceDiscoverer ? { sourceDiscoverer: runtime.sourceDiscoverer } : {}),
        maxResearchCandidates: configuredPositiveInteger(env, 'PI_SOURCE_DISCOVERY_MAX_CANDIDATES', 8),
        minimumAcceptedSources: configuredPositiveInteger(env, 'PI_SOURCE_DISCOVERY_MIN_ACCEPTED', 3),
        separateReadQueries: true,
        phaseReporter: (event) => console.info(JSON.stringify({ event: 'notebooklm_phase', ...event })),
        timeoutMs: configuredPositiveInteger(env, 'NOTEBOOKLM_TIMEOUT_MS', 180_000),
      })
      : new UnavailableProvider('notebooklm', ['collect_sources', 'create_content']),
    runtime.piClient && runtime.piContext
      ? new PiEditorialProvider({
        client: runtime.piClient,
        context: trustedContextResolver(runtime.piContext, runtime.recipeBindingVerifier),
        model: configuredValue(env, 'PI_MODEL') ?? 'pi-editorial',
      })
      : new UnavailableProvider('pi', ['check_content']),
    runtime.mediaClient && runtime.mediaContext
      ? new MediaProviderAdapter({
        client: runtime.mediaClient,
        context: trustedContextResolver(runtime.mediaContext, runtime.recipeBindingVerifier),
      })
      : new UnavailableProvider('media', ['produce_assets'], runtime.configurationIssues?.media),
  ];
}

export function createNotebookLmNotebookProvisioner(env: NodeJS.ProcessEnv = process.env): NotebookLmNotebookProvisioner {
  return new NotebookLmNotebookProvisioner({
    process: new SpawnNotebookLmProcess(),
    command: configuredValue(env, 'NOTEBOOKLM_COMMAND') ?? 'nlm',
    timeoutMs: configuredPositiveInteger(env, 'NOTEBOOKLM_TIMEOUT_MS', 180_000),
  });
}

function configuredRuntime(
  env: NodeJS.ProcessEnv,
  engineClient: WorkerEngineClient | undefined,
  request: typeof fetch,
): ProviderRuntime {
  const recipeRoots = parseProductRecipeRoots(env.PRODUCT_RECIPE_ROOTS);
  if (!engineClient) return {};
  const recipeBindingVerifier = new FileRecipeRegistry(recipeRoots);
  const contexts = new LeaseScopedJobContextResolver(engineClient, recipeBindingVerifier);
  const piProvider = configuredValue(env, 'PI_PROVIDER');
  const piModel = configuredValue(env, 'PI_MODEL');
  const googleCloudProject = configuredValue(env, 'GOOGLE_CLOUD_PROJECT');
  const googleCloudLocation = configuredValue(env, 'GOOGLE_CLOUD_LOCATION');
  const piClient = piProvider && piModel
    ? new LocalPiSdkClient({
      provider: piProvider,
      model: piModel,
      timeoutMs: configuredPositiveInteger(env, 'PI_TIMEOUT_MS', 60_000),
    })
    : undefined;
  const mediaCommand = configuredValue(env, 'MEDIA_GENERATION_COMMAND');
  let mediaArgs: string[] = [];
  let mediaConfigurationIssue: string | undefined;
  try {
    mediaArgs = jsonStringArray(env.MEDIA_GENERATION_ARGS, 'MEDIA_GENERATION_ARGS');
  } catch (error) {
    if (!(error instanceof ProviderNeedsHumanError)) throw error;
    mediaConfigurationIssue = error.message;
  }

  return {
    recipeBindingVerifier,
    ...(mediaConfigurationIssue ? { configurationIssues: { media: mediaConfigurationIssue } } : {}),
    notebookProcess: new SpawnNotebookLmProcess(),
    notebookContext: (input: ProviderExecutionInput) => contexts.notebook(input),
    sourceVerifier: new DeterministicSourceVerifier({
      trustedHosts: commaSeparated(env.SOURCE_TRUSTED_HOSTS),
      allowPublicHosts: true,
      fetch: request,
      timeoutMs: configuredPositiveInteger(env, 'SOURCE_FETCH_TIMEOUT_MS', 20_000),
      maxBytes: configuredPositiveInteger(env, 'SOURCE_SNAPSHOT_MAX_BYTES', 2_000_000),
      maxPdfBytes: configuredPositiveInteger(env, 'SOURCE_PDF_SNAPSHOT_MAX_BYTES', 10_000_000),
    }),
    ...(piClient ? {
      ...(piProvider === 'google-vertex' && googleCloudProject && googleCloudLocation ? {
        sourceDiscoverer: new GoogleGroundedSourceDiscoveryClient({
          model: piModel!,
          project: googleCloudProject,
          location: googleCloudLocation,
          timeoutMs: configuredPositiveInteger(env, 'PI_TIMEOUT_MS', 60_000),
        }),
      } : {}),
      piClient,
      piContext: (input: ProviderExecutionInput) => contexts.pi(input),
    } : {}),
    ...(mediaCommand && !mediaConfigurationIssue ? {
      mediaClient: new LocalMediaCommandClient({
        command: mediaCommand,
        args: mediaArgs,
        process: new SpawnMediaCommandProcess(),
      }),
      mediaContext: (input: ProviderExecutionInput) => contexts.media(input),
    } : {}),
  };
}

export class LeaseScopedJobContextResolver {
  constructor(
    private readonly client: WorkerEngineClient,
    private readonly recipeBindingVerifier?: TrustedRecipeBindingVerifier,
  ) {}

  async notebook(input: ProviderExecutionInput): Promise<NotebookLmContext> {
    const brief = jobBrief(input);
    const generation = await validatedGenerationPlan(
      brief,
      input.job.input.notebookLmNotebookId,
      this.recipeBindingVerifier,
    );
    const notebookId = notebookIdFromJob(input);
    const research = input.action === 'create_content' ? await this.verifiedResearch(input) : undefined;
    const topic = stringValue(brief.title) ?? stringValue(brief.topic) ?? stringValue(brief.objective) ?? 'Knowledge Bits lesson';
    return {
      notebookId,
      sourceUrls: research?.sourceUrls ?? stringArray(brief.sourceUrls),
      topic,
      locale: stringValue(brief.locale) ?? 'en',
      audience: stringValue(brief.audience) ?? 'general adult learners',
      objective: stringValue(brief.objective) ?? topic,
      ...(stringValue(brief.centralIdea) ? { centralIdea: stringValue(brief.centralIdea) } : {}),
      ...(generation ? { generationPlan: generation.plan, resolvedRecipes: generation.recipes } : {}),
      ...(research ? { evidence: research.evidence } : {}),
    };
  }

  async pi(input: ProviderExecutionInput) {
    const generation = await validatedGenerationPlan(
      jobBrief(input),
      input.job.input.notebookLmNotebookId,
      this.recipeBindingVerifier,
    );
    return {
      candidate: await this.content(input),
      evidence: await this.evidence(input),
      rubric: 'Reject unsupported claims, harmful guidance, source leakage, generic filler, and unusable lesson structure.',
      ...(generation ? { generationPlan: generation.plan, resolvedRecipes: generation.recipes } : {}),
    };
  }

  async media(input: ProviderExecutionInput) {
    const brief = jobBrief(input);
    const mediaKinds = mediaKindsFromJob(input.job.input);
    const generation = await validatedGenerationPlan(
      brief,
      input.job.input.notebookLmNotebookId,
      this.recipeBindingVerifier,
      mediaKinds ? mediaRecipeRoles(mediaKinds) : undefined,
    );
    const content = await this.content(input);
    const qa = knowledgeBitsQaSchema.parse(await this.readJsonDependency(input, 'check_content', 'parsed_output'));
    const contentChecksum = calculateContentChecksum(content);
    const mediaOperation = mediaOperationFromJob(input.job.input);
    const generationPlan = isRecord(brief.generationPlan) ? brief.generationPlan : undefined;
    const legacyMediaReuse = generationPlan?.legacyMediaReuse ?? brief.legacyMediaReuse;
    return {
      passedCheck: qa.deterministic.passed
        && qa.deterministic.contentChecksum === contentChecksum,
      content,
      contentChecksum,
      notebookLmNotebookId: notebookIdFromJob(input),
      ...(generation ? { generationPlan: generation.plan, resolvedRecipes: generation.recipes } : {}),
      ...(legacyMediaReuse === undefined ? {} : { legacyMediaReuse }),
      ...(mediaKinds ? { mediaKinds } : {}),
      ...(mediaOperation ? { mediaOperation } : {}),
    };
  }

  private async content(input: ProviderExecutionInput): Promise<ContentCandidate> {
    const value = await this.readJsonDependency(input, 'create_content', 'parsed_output');
    const generationPlan = jobBrief(input).generationPlan;
    if (isRecord(generationPlan) && generationPlan.schemaVersion === '1.1.0') {
      if (!isRecord(value)
        || value.kind !== 'nuglet.lesson.v1'
        || value.schemaVersion !== '1.1.0'
        || !isRecord(value.payload)) {
        throw new ProviderNeedsHumanError('story_playbook_draft_invalid', 'quality');
      }
      const payload = storyPlaybookDraftSchema.safeParse(value.payload);
      if (!payload.success) throw new ProviderNeedsHumanError('story_playbook_draft_invalid', 'quality');
      return { kind: 'nuglet.lesson.v1', schemaVersion: '1.1.0', payload: payload.data };
    }
    return nugletLessonV1PayloadSchema.parse(value);
  }

  private async evidence(input: ProviderExecutionInput): Promise<EvidenceManifest> {
    return (await this.verifiedResearch(input)).evidence;
  }

  private async verifiedResearch(input: ProviderExecutionInput): Promise<{
    evidence: EvidenceManifest;
    sourceUrls: string[];
  }> {
    const research = await this.readJsonDependency(input, 'collect_sources', 'parsed_output');
    if (!Array.isArray(research.acceptedSources)) {
      throw new ProviderNeedsHumanError('research_evidence_invalid');
    }
    const dependencies = dependencyRecords(input);
    const accepted = research.acceptedSources.map((value) => {
        if (!isRecord(value)
          || typeof value.sourceId !== 'string'
          || typeof value.title !== 'string'
          || typeof value.url !== 'string') {
          throw new ProviderNeedsHumanError('research_evidence_invalid');
        }
        const snapshot = dependencies.find((dependency) => (
          dependency.action === 'collect_sources'
          && dependency.kind === 'source_snapshot'
          && dependency.sourceId === value.sourceId
        ));
        if (!snapshot) throw new ProviderNeedsHumanError('research_snapshot_dependency_missing');
        return {
          source: { sourceId: value.sourceId, title: value.title, snapshotArtifactId: snapshot.artifactId },
          url: value.url,
        };
      });
    return {
      evidence: { sources: accepted.map(({ source }) => source) },
      sourceUrls: accepted.map(({ url }) => url),
    };
  }

  private async readJsonDependency(input: ProviderExecutionInput, action: string, kind: string): Promise<Record<string, unknown>> {
    const dependency = [...dependencyRecords(input)].reverse().find((candidate) => (
      candidate.action === action && candidate.kind === kind
    ));
    if (!dependency) throw new ProviderNeedsHumanError(`job_dependency_missing:${action}:${kind}`);
    const artifact = await this.client.readArtifact(input.job, dependency.artifactId, input.signal);
    try {
      const value: unknown = JSON.parse(Buffer.from(artifact.body).toString('utf8'));
      if (!isRecord(value)) throw new TypeError('not an object');
      return value;
    } catch {
      throw new ProviderNeedsHumanError(`job_dependency_invalid:${action}:${kind}`);
    }
  }
}

function notebookIdFromJob(input: ProviderExecutionInput): string {
  const value = input.job.input.notebookLmNotebookId;
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProviderNeedsHumanError('notebooklm_notebook_id_missing');
  }
  return value.trim();
}

export interface PiModelsAdapter {
  complete(input: {
    provider: string;
    model: string;
    systemPrompt: string;
    userPrompt: string;
    sessionId: string;
    signal: AbortSignal;
  }): Promise<string>;
}

export interface GoogleGroundedSearchAdapter {
  search(input: {
    model: string;
    project: string;
    location: string;
    query: string;
    signal: AbortSignal;
  }): Promise<{
    queries: string[];
    sources: Array<{ title: string; url: string }>;
  }>;
}

export class GoogleGroundedSourceDiscoveryClient implements ResearchSourceDiscoveryClient {
  constructor(private readonly options: {
    model: string;
    project: string;
    location: string;
    timeoutMs?: number;
    search?: GoogleGroundedSearchAdapter;
  }) {}

  async discoverSources(input: {
    topic: string;
    audience: string;
    objective: string;
    seedUrls: readonly string[];
    maxCandidates: number;
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<ResearchSourceDiscoveryResult> {
    const maxCandidates = Math.max(1, Math.min(12, Math.floor(input.maxCandidates)));
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 60_000);
    const signal = AbortSignal.any([input.signal, timeout]);
    const query = [
      `Find independent, primary, official, or academic sources for: ${input.topic}.`,
      `Research objective: ${input.objective}.`,
      `Audience: ${input.audience}.`,
      'Prioritize original material, official documentation, reputable analysis, and practical worksheets.',
      input.seedUrls.length ? `Known source URLs to complement, not duplicate: ${input.seedUrls.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    try {
      const result = await (this.options.search ?? new GoogleGenAiGroundedSearchAdapter()).search({
        model: this.options.model,
        project: this.options.project,
        location: this.options.location,
        query,
        signal,
      });
      const candidates = groundedSourceCandidates(result.sources, input.seedUrls, maxCandidates);
      return {
        candidates,
        report: {
          schemaVersion: 'research-source-discovery.v1',
          provider: 'google-vertex-grounding',
          model: this.options.model,
          topic: input.topic,
          seedSourceCount: input.seedUrls.length,
          requestedCandidateCount: maxCandidates,
          returnedCandidateCount: candidates.length,
          searchQueries: result.queries.slice(0, 20),
        },
      };
    } catch (error) {
      if (error instanceof ProviderNeedsHumanError || input.signal.aborted) throw error;
      if (timeout.aborted) {
        throw new ProviderWaitingError('pi_source_discovery_timeout', new Date(Date.now() + 60_000).toISOString());
      }
      if (googleCredentialsRequireReauthentication(error)) {
        throw new ProviderNeedsHumanError('google_credentials_reauthentication_required');
      }
      throw new ProviderWaitingError('pi_source_discovery_unavailable', new Date(Date.now() + 60_000).toISOString());
    }
  }
}

class GoogleGenAiGroundedSearchAdapter implements GoogleGroundedSearchAdapter {
  async search(input: {
    model: string;
    project: string;
    location: string;
    query: string;
    signal: AbortSignal;
  }) {
    const { GoogleGenAI } = await import('@google/genai');
    const client = new GoogleGenAI({
      vertexai: true,
      project: input.project,
      location: input.location,
    });
    const response = await client.models.generateContent({
      model: input.model,
      contents: input.query,
      config: {
        abortSignal: input.signal,
        temperature: 0.1,
        tools: [{ googleSearch: {} }],
      },
    });
    const grounding = response.candidates?.[0]?.groundingMetadata;
    return {
      queries: grounding?.webSearchQueries?.filter((query): query is string => typeof query === 'string') ?? [],
      sources: grounding?.groundingChunks?.flatMap((chunk) => (
        typeof chunk.web?.uri === 'string' && chunk.web.uri.trim()
          ? [{ title: chunk.web.title?.trim() || safeSourceLabel(chunk.web.uri), url: chunk.web.uri.trim() }]
          : []
      )) ?? [],
    };
  }
}

export class LocalPiSdkClient implements PiSdkClient {
  constructor(private readonly options: {
    provider: string;
    model: string;
    timeoutMs?: number;
    models?: PiModelsAdapter;
  }) {}

  async check(input: {
    candidate: ContentCandidate;
    evidence: EvidenceManifest;
    rubric: string;
    renderedPrompt?: string;
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 60_000);
    const signal = AbortSignal.any([input.signal, timeout]);
    try {
      const response = await (this.options.models ?? new PiSdkModelsAdapter()).complete({
        provider: this.options.provider,
        model: this.options.model,
        systemPrompt: 'Return one strict JSON object with summary and findings. Each finding must be exactly {code: string, severity: critical|major|minor, message: string}. Use an empty findings array when there is no issue. Do not rewrite content or request tools.',
        userPrompt: input.renderedPrompt ?? JSON.stringify({
          candidate: input.candidate,
          evidence: input.evidence,
          rubric: input.rubric,
        }),
        sessionId: input.idempotencyKey,
        signal,
      });
      return parseJsonObject(response, 'pi_editorial_invalid_response');
    } catch (error) {
      if (error instanceof ProviderNeedsHumanError || input.signal.aborted) throw error;
      if (timeout.aborted) {
        throw new ProviderWaitingError('pi_editorial_timeout', new Date(Date.now() + 60_000).toISOString());
      }
      if (googleCredentialsRequireReauthentication(error)) {
        throw new ProviderNeedsHumanError('google_credentials_reauthentication_required');
      }
      throw new ProviderWaitingError('pi_editorial_unavailable', new Date(Date.now() + 60_000).toISOString());
    }
  }

}

function googleCredentialsRequireReauthentication(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('invalid_rapt')
    || (message.includes('invalid_grant') && message.toLowerCase().includes('reauth'));
}

class PiSdkModelsAdapter implements PiModelsAdapter {
  async complete(input: {
    provider: string;
    model: string;
    systemPrompt: string;
    userPrompt: string;
    sessionId: string;
    signal: AbortSignal;
  }): Promise<string> {
    const { builtinModels } = await import('@earendil-works/pi-ai/providers/all');
    const models = builtinModels();
    const model = models.getModel(input.provider, input.model);
    if (!model || !await models.getAuth(model)) throw new ProviderNeedsHumanError('pi_model_or_credentials_unconfigured');
    const response = await models.complete(model, {
      systemPrompt: input.systemPrompt,
      messages: [{ role: 'user', content: input.userPrompt, timestamp: Date.now() }],
    }, {
      signal: input.signal,
      sessionId: input.sessionId,
    });
    if (response.stopReason === 'aborted') throw input.signal.reason;
    if (response.stopReason === 'error') throw new Error(response.errorMessage ?? 'Pi request failed');
    return response.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n');
  }
}

function groundedSourceCandidates(
  sources: readonly { title: string; url: string }[],
  seedUrls: readonly string[],
  maxCandidates: number,
): ResearchSourceCandidate[] {
  const seedHosts = new Set(seedUrls.flatMap((value) => {
    try {
      return [new URL(value).hostname.toLowerCase().replace(/^www\./, '')];
    } catch {
      return [];
    }
  }));
  const lowSignalHosts = new Set([
    'ebay.com',
    'goodreads.com',
    'lobehub.com',
    'medium.com',
    'reddit.com',
    'scribd.com',
  ]);
  const ranked = sources.flatMap((source, index) => {
    let url: URL;
    try {
      url = new URL(source.url);
    } catch {
      return [];
    }
    if (publicUrlRejectionReason(url)) return [];
    const title = source.title.trim().replace(/^www\./, '').toLowerCase();
    const official = [...seedHosts].some((host) => title === host || title.endsWith(`.${host}`));
    const lowSignal = [...lowSignalHosts].some((host) => title === host || title.endsWith(`.${host}`));
    return [{
      index,
      rank: official ? 0 : lowSignal ? 2 : 1,
      official,
      title: source.title.trim() || sourceLabel(url),
      url: url.toString(),
    }];
  }).sort((left, right) => left.rank - right.rank || left.index - right.index);
  const candidates: ResearchSourceCandidate[] = [];
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  for (const source of ranked) {
    const titleKey = source.title.toLowerCase();
    if (seenUrls.has(source.url) || seenTitles.has(titleKey)) continue;
    seenUrls.add(source.url);
    seenTitles.add(titleKey);
    candidates.push({
      sourceId: `google-grounded-source-${createHash('sha256').update(source.url).digest('hex').slice(0, 16)}`,
      title: source.title.slice(0, 240),
      url: source.url,
      sourceType: source.official ? 'official' : 'independent-analysis',
      rationale: 'Google Search grounding candidate; deterministic retrieval and source review are still required.',
    });
    if (candidates.length >= maxCandidates) break;
  }
  return candidates;
}

function sourceLabel(url: URL): string {
  return `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/$/, '')}`;
}

function safeSourceLabel(value: string): string {
  try {
    return sourceLabel(new URL(value));
  } catch {
    return value;
  }
}

export interface MediaCommandProcess {
  run(input: {
    command: string;
    args: readonly string[];
    stdin: string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut?: boolean }>;
}

export class LocalMediaCommandClient implements MediaClient {
  constructor(private readonly options: {
    command: string;
    args?: readonly string[];
    process: MediaCommandProcess;
    timeoutMs?: number;
  }) {}

  async generate(input: {
    content: ContentCandidate;
    generationInputChecksum: string;
    kinds: readonly MediaKind[];
    idempotencyKey: string;
    notebookLmNotebookId: string;
    heroDirection: NugletGenerationPlan['heroDirection'];
    mediaBaseline?: NugletMediaBaseline;
    resolvedRecipes: SelectedMediaRecipes;
    executionInput: ProviderExecutionInput;
    legacyMediaReuse?: unknown;
    mediaOperation?: MediaOperation;
    signal: AbortSignal;
  }): Promise<readonly GeneratedMedia[]> {
    const regeneratedKinds = regeneratedMediaKindsFromJob(input.executionInput.job.input);
    const result = await this.options.process.run({
      command: this.options.command,
      args: this.options.args ?? [],
      stdin: JSON.stringify({
        runId: input.executionInput.job.packageId,
        content: input.content,
        generationInputChecksum: input.generationInputChecksum,
        kinds: input.kinds,
        idempotencyKey: input.idempotencyKey,
        notebookLmNotebookId: input.notebookLmNotebookId,
        heroDirection: input.heroDirection,
        ...(input.mediaBaseline ? { mediaBaseline: input.mediaBaseline } : {}),
        recipeSnapshots: serializeMediaRecipes(input.resolvedRecipes),
        ...(input.legacyMediaReuse === undefined ? {} : { legacyMediaReuse: input.legacyMediaReuse }),
        ...(input.mediaOperation ? { mediaOperation: input.mediaOperation } : {}),
        ...(regeneratedKinds.length ? { regeneratedKinds } : {}),
      }),
      timeoutMs: this.options.timeoutMs ?? 600_000,
      signal: input.signal,
    });
    if (result.timedOut) {
      throw new ProviderWaitingError('media_generation_timeout', new Date(Date.now() + 60_000).toISOString());
    }
    if (result.exitCode !== 0) {
      const waitingReason = mediaWaitingReason(result.stderr);
      if (waitingReason) {
        throw new ProviderWaitingError(waitingReason, new Date(Date.now() + 60_000).toISOString());
      }
      const detail = mediaCommandFailureDetail(result.stderr);
      throw new ProviderNeedsHumanError(
        `media_generation_command_failed:${result.exitCode ?? 'signal'}${detail ? `:${detail}` : ''}`,
      );
    }
    const response = parseJsonObject(result.stdout, 'media_generation_invalid_response');
    if (!Array.isArray(response.assets)) throw new ProviderNeedsHumanError('media_generation_invalid_response');
    return response.assets.map((asset) => parseMediaAsset(asset, input));
  }
}

function regeneratedMediaKindsFromJob(input: Record<string, unknown>): readonly MediaKind[] {
  const brief = isRecord(input.brief) ? input.brief : undefined;
  const regeneration = isRecord(brief?.mediaRegeneration) ? brief.mediaRegeneration : undefined;
  if (!Array.isArray(regeneration?.regeneratedKinds)) return [];
  const validKinds: readonly MediaKind[] = ['hero', 'infographic', 'audio_brief', 'audio_discussion', 'public_preview'];
  return [...new Set(regeneration.regeneratedKinds.filter(
    (kind): kind is MediaKind => typeof kind === 'string' && validKinds.includes(kind as MediaKind),
  ))];
}

function mediaWaitingReason(stderr: string): string | undefined {
  const match = stderr.match(/(?:^|\n)MEDIA_WAITING:([^\n]+)/);
  return match?.[1] ? normalizeProviderReason(match[1], 'media_generation_waiting') : undefined;
}

function mediaCommandFailureDetail(stderr: string): string | undefined {
  const line = stderr.trim().split(/\r?\n/).filter(Boolean).at(-1);
  return line ? normalizeProviderReason(line, 'media_command_error') : undefined;
}

function normalizeProviderReason(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return normalized || fallback;
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
  }) {
    return runProcess(input);
  }
}

class SpawnMediaCommandProcess implements MediaCommandProcess {
  async run(input: {
    command: string;
    args: readonly string[];
    stdin: string;
    timeoutMs: number;
    signal: AbortSignal;
  }) {
    return runProcess(input);
  }
}

export function runProcess(input: {
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
    let forceKill: NodeJS.Timeout | undefined;
    const terminate = () => {
      child.kill('SIGTERM');
      forceKill ??= setTimeout(() => child.kill('SIGKILL'), 1_000);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, input.timeoutMs);
    const abort = () => terminate();
    input.signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      input.signal.removeEventListener('abort', abort);
      reject(classifyProcessStartError(error, input.command));
    });
    child.once('close', (exitCode) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      input.signal.removeEventListener('abort', abort);
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode,
        timedOut,
      });
    });
    if (input.stdin) child.stdin.write(input.stdin);
    child.stdin.end();
    if (input.signal.aborted) abort();
  });
}

function classifyProcessStartError(error: Error, command: string): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return new ProviderNeedsHumanError(`provider_executable_not_found:${command}`);
  if (code === 'EACCES' || code === 'EPERM') {
    return new ProviderNeedsHumanError(`provider_executable_not_executable:${command}`);
  }
  return error;
}

function dependencyRecords(input: ProviderExecutionInput): Array<{
  artifactId: string;
  revision: number;
  kind: string;
  mediaType: string;
  checksum: string;
  action: string;
  sourceId?: string;
}> {
  if (!Array.isArray(input.job.input.dependencies)) return [];
  return input.job.input.dependencies.flatMap((value) => {
    if (!isRecord(value)
      || typeof value.artifactId !== 'string'
      || typeof value.revision !== 'number'
      || typeof value.kind !== 'string'
      || typeof value.mediaType !== 'string'
      || typeof value.checksum !== 'string'
      || typeof value.action !== 'string') return [];
    return [{
      artifactId: value.artifactId,
      revision: value.revision,
      kind: value.kind,
      mediaType: value.mediaType,
      checksum: value.checksum,
      action: value.action,
      ...(typeof value.sourceId === 'string' ? { sourceId: value.sourceId } : {}),
    }];
  });
}

function jobBrief(input: ProviderExecutionInput): Record<string, unknown> {
  const brief = input.job.input.brief;
  if (!isRecord(brief)) throw new ProviderNeedsHumanError('job_brief_missing');
  return brief;
}

async function validatedGenerationPlan(
  brief: Record<string, unknown>,
  runNotebookLmNotebookId: unknown,
  verifier: TrustedRecipeBindingVerifier | undefined,
  selectedRoles?: readonly NugletRecipeRole[],
): Promise<{ plan: NugletGenerationPlan; recipes: Partial<ResolvedNugletRecipes> } | undefined> {
  const value = brief.generationPlan;
  if (value === undefined) {
    if (brief.contentKind === 'nuglet.lesson.v1') {
      throw new ProviderNeedsHumanError('generation_plan_missing');
    }
    return undefined;
  }
  if (!isRecord(value)) throw new ProviderNeedsHumanError('generation_plan_invalid');
  if (value.contentKind !== 'nuglet.lesson.v1') {
    if (brief.contentKind === 'nuglet.lesson.v1') {
      throw new ProviderNeedsHumanError('generation_plan_invalid');
    }
    return undefined;
  }
  const parsed = nugletGenerationPlanSchema.safeParse(value);
  if (!parsed.success) throw new ProviderNeedsHumanError('generation_plan_invalid');
  const parsedBrief = knowledgeBitsRunBriefSchema.safeParse(brief);
  if (!parsedBrief.success) throw new ProviderNeedsHumanError('run_brief_invalid');
  if (runNotebookLmNotebookId !== parsedBrief.data.notebookLmNotebookId) {
    throw new ProviderNeedsHumanError('run_notebook_id_mismatch');
  }
  if (!verifier) throw new ProviderNeedsHumanError('generation_recipe_verifier_unconfigured');
  let recipes: Partial<ResolvedNugletRecipes>;
  try {
    if (selectedRoles) {
      if (!verifier.resolve) throw new Error('Scoped recipe resolution is unavailable');
      recipes = Object.fromEntries(await Promise.all(selectedRoles.map(async (role) => [
        role,
        await verifier.resolve!({
          contentKind: parsed.data.contentKind,
          ...parsed.data.recipes[role],
        }),
      ])));
    } else {
      recipes = await verifier.resolvePlan(parsed.data);
    }
  } catch (error) {
    if (error instanceof ProviderNeedsHumanError) throw error;
    throw new ProviderNeedsHumanError('generation_recipe_verification_failed');
  }
  if (!resolvedRecipesMatchPlan(parsed.data, recipes, selectedRoles)) {
    throw new ProviderNeedsHumanError('generation_recipe_binding_mismatch');
  }
  return { plan: parsed.data, recipes };
}

function trustedContextResolver<T extends { generationPlan?: NugletGenerationPlan; resolvedRecipes?: Partial<ResolvedNugletRecipes> }>(
  resolver: (input: ProviderExecutionInput) => Promise<T>,
  verifier: TrustedRecipeBindingVerifier | undefined,
): (input: ProviderExecutionInput) => Promise<T> {
  return async (input) => {
    const mediaKinds = input.action === 'produce_assets'
      ? mediaKindsFromJob(input.job.input)
      : undefined;
    const generation = await validatedGenerationPlan(
      jobBrief(input),
      input.job.input.notebookLmNotebookId,
      verifier,
      mediaKinds ? mediaRecipeRoles(mediaKinds) : undefined,
    );
    const context = await resolver(input);
    return generation
      ? { ...context, generationPlan: generation.plan, resolvedRecipes: generation.recipes }
      : context;
  };
}

function resolvedRecipesMatchPlan(
  plan: NugletGenerationPlan,
  recipes: Partial<ResolvedNugletRecipes>,
  selectedRoles?: readonly NugletRecipeRole[],
): boolean {
  const entries = selectedRoles
    ? selectedRoles.map((role) => [role, plan.recipes[role]] as const)
    : Object.entries(plan.recipes);
  return entries.every(([role, binding]) => {
    const recipe = recipes[role as keyof ResolvedNugletRecipes];
    return recipe?.id === binding.id
      && recipe.version === binding.version
      && recipe.checksum === binding.checksum;
  });
}

function parseMediaAsset(
  value: unknown,
  input: {
    resolvedRecipes: SelectedMediaRecipes;
    executionInput: ProviderExecutionInput;
    mediaOperation?: MediaOperation;
  },
): GeneratedMedia {
  const isExisting = input.mediaOperation === 'attach_existing';
  if (!isRecord(value)
    || (value.kind !== 'hero'
      && value.kind !== 'infographic'
      && value.kind !== 'audio_brief'
      && value.kind !== 'audio_discussion'
      && value.kind !== 'public_preview')
    || typeof value.mediaType !== 'string'
    || typeof value.bytesBase64 !== 'string'
    || typeof value.generationInputChecksum !== 'string'
    || !isRecord(value.metadata)
    || !isRecord(value.support)
    || (isExisting
      ? !isRecord(value.support.reuse)
      : !Array.isArray(value.support.executions)
        || (value.kind !== 'public_preview' && value.support.executions.length === 0))) {
    throw new ProviderNeedsHumanError('media_generation_invalid_response');
  }
  const bytes = Buffer.from(value.bytesBase64, 'base64');
  if (bytes.byteLength === 0) throw new ProviderNeedsHumanError('media_generation_invalid_response');
  const executions: readonly unknown[] = isExisting ? [] : value.support.executions as unknown[];
  const supportArtifacts = isExisting || value.kind === 'public_preview'
    ? []
    : (() => {
        const recipe = recipeForKind(input.resolvedRecipes, value.kind);
        return executions.flatMap((execution: unknown) => (
          parseMediaExecutionEvidence(execution, recipe, input.executionInput)
        ));
      })();
  return {
    kind: value.kind,
    mediaType: value.mediaType,
    bytes,
    generationInputChecksum: value.generationInputChecksum,
    metadata: value.metadata,
    supportArtifacts,
  };
}

function parseMediaExecutionEvidence(
  value: unknown,
  recipe: ReturnType<typeof recipeForKind>,
  executionInput: ProviderExecutionInput,
) {
  if (!isRecord(value)
    || !isRecord(value.recipe)
    || value.recipe.id !== recipe.id
    || value.recipe.version !== recipe.version
    || value.recipe.checksum !== recipe.checksum
    || typeof value.promptBase64 !== 'string'
    || typeof value.promptChecksum !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(value.promptChecksum)
    || typeof value.model !== 'string'
    || !value.model.trim()
    || typeof value.provider !== 'string'
    || !value.provider.trim()
    || !Array.isArray(value.referenceChecksums)
    || !value.referenceChecksums.every((checksum) => (
      typeof checksum === 'string' && /^sha256:[a-f0-9]{64}$/.test(checksum)
    ))
    || (value.artifactId !== undefined && (typeof value.artifactId !== 'string' || !value.artifactId.trim()))
    || (value.notebookId !== undefined && (typeof value.notebookId !== 'string' || !value.notebookId.trim()))
    || (value.provider === 'notebooklm' && (typeof value.artifactId !== 'string' || typeof value.notebookId !== 'string'))) {
    throw new ProviderNeedsHumanError('media_generation_invalid_response');
  }
  const prompt = decodeBase64(value.promptBase64, 'media_generation_invalid_response');
  if (`sha256:${createHash('sha256').update(prompt).digest('hex')}` !== value.promptChecksum) {
    throw new ProviderNeedsHumanError('media_generation_invalid_response');
  }
  return generationSupportArtifacts({
    recipe,
    prompt,
    model: value.model,
    executionInput,
  }).map((artifact) => ({
    ...artifact,
    provenance: {
      ...artifact.provenance,
      provider: 'media',
      upstreamProvider: value.provider,
      ...(value.artifactId === undefined ? {} : { artifactId: value.artifactId }),
      ...(value.notebookId === undefined ? {} : { notebookId: value.notebookId }),
      referenceChecksums: value.referenceChecksums as string[],
    },
  }));
}

function decodeBase64(value: string, reason: string): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength === 0 || bytes.toString('base64') !== value.replace(/\s/g, '')) {
    throw new ProviderNeedsHumanError(reason);
  }
  return bytes;
}

function serializeMediaRecipes(recipes: SelectedMediaRecipes): Record<string, unknown> {
  return Object.fromEntries(Object.entries(recipes).map(([role, recipe]) => [role, {
    id: recipe.id,
    version: recipe.version,
    checksum: recipe.checksum,
    canonicalBase64: Buffer.from(recipe.canonicalBytes).toString('base64'),
  }]));
}

function mediaRecipeRoles(kinds: readonly MediaKind[]): readonly NugletRecipeRole[] {
  return [...new Set(kinds.flatMap((kind) => {
    if (kind === 'hero') return ['hero'] as const;
    if (kind === 'infographic') return ['infographic'] as const;
    if (kind === 'audio_brief') return ['audioBrief'] as const;
    if (kind === 'audio_discussion') return ['audioDiscussion'] as const;
    return [];
  }))];
}

function mediaKindsFromJob(input: Record<string, unknown>): readonly MediaKind[] | undefined {
  if (input.mediaKinds === undefined) return undefined;
  const validKinds: readonly MediaKind[] = ['hero', 'infographic', 'audio_brief', 'audio_discussion', 'public_preview'];
  if (!Array.isArray(input.mediaKinds)
    || input.mediaKinds.length === 0
    || input.mediaKinds.some((kind) => typeof kind !== 'string' || !validKinds.includes(kind as MediaKind))) {
    throw new ProviderNeedsHumanError('media_kinds_invalid');
  }
  const kinds = [...new Set(input.mediaKinds as MediaKind[])];
  return kinds;
}

function mediaOperationFromJob(input: Record<string, unknown>): MediaOperation | undefined {
  if (input.mediaOperation === undefined) return undefined;
  if (input.mediaOperation !== 'attach_existing' && input.mediaOperation !== 'generate') {
    throw new ProviderNeedsHumanError('media_operation_invalid');
  }
  return input.mediaOperation;
}

function parseJsonObject(value: string, reason: string): Record<string, unknown> {
  try {
    const unfenced = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed: unknown = JSON.parse(unfenced);
    if (!isRecord(parsed)) throw new TypeError('not an object');
    return parsed;
  } catch {
    throw new ProviderNeedsHumanError(reason);
  }
}

function commaSeparated(value: string | undefined): string[] {
  return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
}

function jsonStringArray(value: string | undefined, name: string): string[] {
  if (!value?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) throw new TypeError();
    return parsed;
  } catch {
    throw new ProviderNeedsHumanError(`${name.toLowerCase()}_invalid`);
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function configuredValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

function configuredPositiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = configuredValue(env, name);
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
