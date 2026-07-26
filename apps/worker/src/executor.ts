import { createHash } from 'node:crypto';

import type { ArtifactCompleteRequest, JobClaim, JobResult, WorkflowStage } from '@knowledge-bits/contracts';

import type { WorkerEngineClient } from './engine-client.js';
import {
  ProviderNeedsHumanError,
  ProviderWaitingError,
  type ProviderBinaryAsset,
  type ProviderExecution,
  type ProviderSupportArtifact,
  type WorkerAction,
  type WorkerProvider,
} from './providers/types.js';

const ACTION_BY_STAGE: Readonly<Record<WorkflowStage, WorkerAction | null>> = {
  research: 'collect_sources',
  create: 'create_content',
  check: 'check_content',
  produce_assets: 'produce_assets',
  human_review: null,
  deliver: 'deliver_package',
};

class GenerationProvenanceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'GenerationProvenanceError';
  }
}

export interface IntervalScheduler {
  setInterval(callback: () => void | Promise<void>, delay: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void | Promise<void>, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface WorkerExecutorOptions {
  client: WorkerEngineClient;
  providers: readonly WorkerProvider[];
  now?: () => Date;
  scheduler?: IntervalScheduler;
}

export class WorkerExecutor {
  private readonly now: () => Date;
  private readonly scheduler: IntervalScheduler;

  constructor(private readonly options: WorkerExecutorOptions) {
    this.now = options.now ?? (() => new Date());
    this.scheduler = options.scheduler ?? systemScheduler;
  }

  async execute(job: JobClaim, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;

    if (job.stage === 'deliver') {
      await this.executeDelivery(job, signal);
      return;
    }

    const action = actionForStage(job.stage);
    if (!action) return;

    const provider = this.options.providers.find((candidate) => candidate.capabilities.includes(action));
    if (!provider) {
      await this.reportUnsupportedAction(job, action, signal);
      return;
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let reportingAllowed = !signal?.aborted;
    let heartbeatInFlight = false;
    let deadlineReached = false;
    const heartbeat = async () => {
      if (!reportingAllowed || heartbeatInFlight) return;
      heartbeatInFlight = true;
      try {
        const result = await this.options.client.heartbeat(job);
        if (result.kind === 'interrupted') {
          reportingAllowed = false;
          controller.abort();
        }
      } catch {
        reportingAllowed = false;
        controller.abort();
      } finally {
        heartbeatInFlight = false;
      }
    };
    const heartbeatHandle = this.scheduler.setInterval(heartbeat, heartbeatIntervalMs(job));
    const deadlineHandle = this.scheduler.setTimeout(() => {
      deadlineReached = true;
      this.scheduler.clearInterval(heartbeatHandle);
      controller.abort();
    }, executionDeadlineMs(job, this.now()));

    try {
      const execution = await this.executeProvider(provider, {
        job,
        action,
        idempotencyKey: operationIdempotencyKey(job, action),
        signal: controller.signal,
      });
      if (deadlineReached && !signal?.aborted) {
        await this.reportTypedResult(job, deadlineWait(this.now()), signal);
        return;
      }
      if (!reportingAllowed || signal?.aborted || controller.signal.aborted) return;

      if (execution.kind !== 'success') {
        if (execution.kind === 'needs_human' && execution.candidate) {
          const candidate = { kind: 'success' as const, ...execution.candidate };
          const safeProviderReport = redactExecutionReport(candidate.executionReport);
          const reportBytes = canonicalJsonBytes({
            action,
            jobId: job.jobId,
            packageId: job.packageId,
            provider: provider.name,
            providerReport: safeProviderReport,
            idempotencyKey: operationIdempotencyKey(job, action),
            reviewCandidate: true,
          });
          try {
            await this.uploadExecutionArtifacts(job, provider.name, candidate, reportBytes, controller.signal);
          } catch (error) {
            if (error instanceof GenerationProvenanceError) {
              await this.reportTypedResult(job, {
                kind: 'needs_human',
                needsHumanKind: 'configuration',
                reason: error.code,
              }, controller.signal);
              return;
            }
            throw error;
          }
        }
        await this.reportTypedResult(job, execution, controller.signal);
        return;
      }

      const safeProviderReport = redactExecutionReport(execution.executionReport);
      const reportBytes = canonicalJsonBytes({
        action,
        jobId: job.jobId,
        packageId: job.packageId,
        provider: provider.name,
        providerReport: safeProviderReport,
        idempotencyKey: operationIdempotencyKey(job, action),
      });
      const outputChecksum = checksum(reportBytes);
      if (execution.assets?.some((asset) => !(
        job.stage === 'produce_assets'
        || (job.stage === 'research' && asset.kind === 'source_snapshot')
      ))) {
        await this.reportTypedResult(job, {
          kind: 'needs_human',
          needsHumanKind: 'configuration',
          reason: 'provider_assets_not_allowed_for_stage',
        }, controller.signal);
        return;
      }
      try {
        await this.uploadExecutionArtifacts(job, provider.name, execution, reportBytes, controller.signal);
      } catch (error) {
        if (error instanceof GenerationProvenanceError) {
          await this.reportTypedResult(job, {
            kind: 'needs_human',
            needsHumanKind: 'configuration',
            reason: error.code,
          }, controller.signal);
          return;
        }
        throw error;
      }
      if (!reportingAllowed || controller.signal.aborted) return;

      await this.options.client.reportResult({
        jobId: job.jobId,
        packageId: job.packageId,
        stage: job.stage,
        state: 'done',
        completedAt: this.now().toISOString(),
        outputChecksum,
        error: null,
      }, undefined, controller.signal);
      if (controller.signal.aborted) return;
    } catch (error) {
      if (deadlineReached && !signal?.aborted) {
        await this.reportTypedResult(job, deadlineWait(this.now()), signal);
        return;
      }
      if (controller.signal.aborted) return;
      throw error;
    } finally {
      this.scheduler.clearInterval(heartbeatHandle);
      this.scheduler.clearTimeout(deadlineHandle);
      signal?.removeEventListener('abort', abort);
    }
  }

  private async executeDelivery(job: JobClaim, signal?: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let heartbeatInFlight = false;
    const heartbeat = async () => {
      if (heartbeatInFlight || controller.signal.aborted) return;
      heartbeatInFlight = true;
      try {
        const result = await this.options.client.heartbeat(job);
        if (result.kind === 'interrupted') controller.abort();
      } catch {
        controller.abort();
      } finally {
        heartbeatInFlight = false;
      }
    };
    const heartbeatHandle = this.scheduler.setInterval(heartbeat, heartbeatIntervalMs(job));
    const deadlineHandle = this.scheduler.setTimeout(() => {
      this.scheduler.clearInterval(heartbeatHandle);
      controller.abort();
    }, executionDeadlineMs(job, this.now()));
    try {
      await this.options.client.runDelivery(job, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      this.scheduler.clearInterval(heartbeatHandle);
      this.scheduler.clearTimeout(deadlineHandle);
      signal?.removeEventListener('abort', abort);
    }
  }

  private async executeProvider(
    provider: WorkerProvider,
    input: Parameters<WorkerProvider['execute']>[0],
  ): Promise<ProviderExecution> {
    try {
      return await provider.execute(input);
    } catch (error) {
      if (error instanceof ProviderWaitingError) {
        return { kind: 'waiting', reason: error.message, retryAt: error.retryAt };
      }
      if (error instanceof ProviderNeedsHumanError) {
        return { kind: 'needs_human', needsHumanKind: error.needsHumanKind, reason: error.message };
      }
      return {
        kind: 'waiting',
        reason: errorMessage(error),
        retryAt: new Date(this.now().getTime() + 60_000).toISOString(),
      };
    }
  }

  private async uploadExecutionArtifacts(
    job: JobClaim,
    provider: string,
    execution: Extract<ProviderExecution, { kind: 'success' }>,
    reportBytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    const rawChecksum = checksum(execution.rawResponse);
    const parsedBytes = canonicalJsonBytes(execution.parsedOutput);
    const parsedChecksum = checksum(parsedBytes);
    const supportArtifacts = bindGenerationOutputs(
      job,
      execution.supportArtifacts ?? [],
      execution.assets ?? [],
      parsedChecksum,
    );
    const generationProvenance = validateGenerationProvenance(
      job,
      provider,
      supportArtifacts,
    );
    const artifacts: ExecutionArtifact[] = [
      ...supportArtifacts
        .filter((artifact) => artifact.kind !== 'generation.execution.report')
        .map((artifact) => ({
          kind: artifact.kind,
          body: artifact.body,
          mediaType: artifact.mediaType,
          inputChecksum: artifact.inputChecksum,
          provenance: sanitizeProvenance(artifact.provenance),
        })),
      ...(execution.assets ?? []).map((asset) => ({
        kind: asset.kind,
        body: asset.body,
        mediaType: asset.mediaType,
        inputChecksum: asset.inputChecksum,
        provenance: asset.provenance,
      })),
      { kind: 'raw_response', body: execution.rawResponse, inputChecksum: execution.inputChecksum ?? null },
      { kind: 'parsed_output', body: parsedBytes, inputChecksum: rawChecksum },
      {
        kind: 'generation.execution.report',
        body: reportBytes,
        inputChecksum: parsedChecksum,
        provenance: generationProvenance,
      },
    ];

    for (const artifact of artifacts) {
      if (signal?.aborted) return;
      const prepared = await this.options.client.prepareArtifact({
        jobId: job.jobId,
        runId: job.packageId,
        revision: job.revision,
        kind: artifact.kind,
        mediaType: artifact.mediaType ?? 'application/json',
      }, signal);
      if (signal?.aborted) return;
      await this.options.client.uploadArtifact(prepared, artifact.body, signal);
      if (signal?.aborted) return;
      const completion: ArtifactCompleteRequest = {
        jobId: job.jobId,
        artifactId: prepared.artifactId,
        runId: job.packageId,
        revision: job.revision,
        kind: artifact.kind,
        mediaType: artifact.mediaType ?? 'application/json',
        checksum: checksum(artifact.body),
        byteSize: artifact.body.byteLength,
        provider,
        inputChecksum: artifact.inputChecksum,
        provenance: bindExecutorProvenance(job, provider, artifact.provenance),
      };
      await this.options.client.completeArtifact(completion, signal);
      if (signal?.aborted) return;
    }
  }

  private async reportTypedResult(
    job: JobClaim,
    execution: Exclude<ProviderExecution, { kind: 'success' }>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return;
    const result: JobResult = {
      jobId: job.jobId,
      packageId: job.packageId,
      stage: job.stage,
      state: execution.kind,
      completedAt: this.now().toISOString(),
      outputChecksum: null,
      error: execution.reason,
      ...(execution.kind === 'needs_human' ? { needsHumanKind: execution.needsHumanKind } : {}),
    };
    await this.options.client.reportResult(
      result,
      execution.kind === 'waiting' ? execution.retryAt : undefined,
      signal,
    );
  }

  private async reportUnsupportedAction(job: JobClaim, action: WorkerAction, signal?: AbortSignal): Promise<void> {
    const reason = `No configured provider supports ${action}`;
    const execution: Exclude<ProviderExecution, { kind: 'success' }> = {
      kind: 'needs_human', needsHumanKind: 'configuration', reason,
    };
    await this.reportTypedResult(job, execution, signal);
  }
}

function validateGenerationProvenance(
  job: JobClaim,
  provider: string,
  artifacts: readonly ProviderSupportArtifact[],
): Readonly<Record<string, unknown>> | undefined {
  const evidenceArtifacts = artifacts.filter(({ kind }) => kind !== 'generation.execution.report');
  if (evidenceArtifacts.length === 0) return undefined;
  const executorProvenance = executorProvenanceFor(job, provider);
  const groups = new Map<string, Array<{ artifact: ProviderSupportArtifact; provenance: GenerationProvenance }>>();
  for (const artifact of evidenceArtifacts) {
    const candidate = artifact.provenance;
    for (const [key, value] of Object.entries(executorProvenance)) {
      if (candidate[key] !== undefined && !sameValue(candidate[key], value)) {
        throw new GenerationProvenanceError('generation_provenance_conflict');
      }
    }
    const provenance = readGenerationProvenance(candidate);
    const key = [
      provenance.recipeId,
      provenance.recipeVersion,
      provenance.recipeChecksum,
      provenance.promptChecksum,
    ].join('\0');
    const group = groups.get(key) ?? [];
    group.push({ artifact, provenance });
    groups.set(key, group);
  }

  const executions: GenerationProvenance[] = [];
  for (const group of groups.values()) {
    const recipeSnapshots = group.filter(({ artifact }) => artifact.kind === 'generation.recipe.snapshot');
    const prompts = group.filter(({ artifact }) => artifact.kind === 'generation.prompt.rendered');
    if (recipeSnapshots.length !== 1 || prompts.length !== 1) {
      throw new GenerationProvenanceError('generation_provenance_missing');
    }
    const expected = group[0]!.provenance;
    if (group.some(({ provenance }) => !sameGenerationProvenance(provenance, expected))) {
      throw new GenerationProvenanceError('generation_provenance_conflict');
    }
    if (!recipeIsBoundToJobPlan(job, expected)) {
      throw new GenerationProvenanceError('generation_provenance_recipe_mismatch');
    }
    if (expected.recipeChecksum !== prefixedChecksum(recipeSnapshots[0]!.artifact.body)
      || expected.promptChecksum !== prefixedChecksum(prompts[0]!.artifact.body)) {
      throw new GenerationProvenanceError('generation_provenance_checksum_mismatch');
    }
    executions.push(expected);
  }
  if (executions.length === 1) return executions[0];
  return { generationExecutions: executions };
}

function readGenerationProvenance(value: Readonly<Record<string, unknown>>): GenerationProvenance {
  const recipeId = requiredString(value.recipeId);
  const recipeVersion = requiredString(value.recipeVersion);
  const recipeChecksum = requiredChecksum(value.recipeChecksum);
  const promptChecksum = requiredChecksum(value.promptChecksum);
  const model = requiredString(value.model);
  const outputKind = requiredString(value.outputKind);
  const outputChecksum = requiredChecksum(value.outputChecksum);
  const referenceChecksums = requiredChecksums(value.referenceChecksums);
  if (!recipeId || !recipeVersion || !recipeChecksum || !promptChecksum || !model
    || !outputKind || !outputChecksum || !referenceChecksums) {
    throw new GenerationProvenanceError('generation_provenance_missing');
  }
  return {
    recipeId,
    recipeVersion,
    recipeChecksum,
    promptChecksum,
    model,
    outputKind,
    outputChecksum,
    referenceChecksums,
  };
}

function requiredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function requiredChecksum(value: unknown): string | undefined {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value) ? value : undefined;
}

function requiredChecksums(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || !value.every((checksum) => requiredChecksum(checksum))) return undefined;
  return value;
}

function sameGenerationProvenance(left: GenerationProvenance, right: GenerationProvenance): boolean {
  return left.recipeId === right.recipeId
    && left.recipeVersion === right.recipeVersion
    && left.recipeChecksum === right.recipeChecksum
    && left.promptChecksum === right.promptChecksum
    && left.model === right.model
    && left.outputKind === right.outputKind
    && left.outputChecksum === right.outputChecksum
    && sameValue(left.referenceChecksums, right.referenceChecksums);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function executorProvenanceFor(job: JobClaim, provider: string): Readonly<Record<string, unknown>> {
  const action = actionForStage(job.stage);
  if (!action) throw new TypeError(`No worker action exists for ${job.stage}`);
  return {
    action,
    idempotencyKey: operationIdempotencyKey(job, action),
    jobId: job.jobId,
    provider,
    attempt: job.attempt,
  };
}

function bindExecutorProvenance(
  job: JobClaim,
  provider: string,
  provenance: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  return {
    ...sanitizeProvenance(provenance ?? {}),
    ...executorProvenanceFor(job, provider),
  };
}

function redactExecutionReport(value: unknown): unknown {
  const secretValues = Object.entries(process.env)
    .filter(([key, item]) => SENSITIVE_KEY.test(key) && typeof item === 'string' && item.length >= 8)
    .map(([, item]) => item as string);
  return redactValue(value, secretValues, new WeakSet<object>());
}

function sanitizeProvenance(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const sanitized = redactExecutionReport(value);
  return isRecord(sanitized) ? sanitized : {};
}

function redactValue(value: unknown, secrets: readonly string[], seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactString(value, secrets);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[REDACTED_CYCLE]';
    seen.add(value);
    return value.map((item) => redactValue(item, secrets, seen));
  }
  if (isRecord(value)) {
    if (seen.has(value)) return '[REDACTED_CYCLE]';
    seen.add(value);
    return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => (
      isSensitiveKey(key) || isPathKey(key)
        ? []
        : [[key, redactValue(item, secrets, seen)]]
    )));
  }
  return null;
}

function redactString(value: string, secrets: readonly string[]): string {
  const withoutUrls = value.replace(ABSOLUTE_URL_PATTERN, '[REDACTED_URL]');
  const withoutEnvironmentSecrets = secrets.reduce(
    (safe, secret) => safe.replaceAll(secret, '[REDACTED]'),
    withoutUrls,
  );
  const withoutCredentialLiterals = withoutEnvironmentSecrets
    .replace(/\b(?:bearer|basic|token)\s+[A-Za-z0-9._~+\/=:-]{8,}\b/gi, '[REDACTED]')
    .replace(/\b(?:sk|pk|rk|api)[_-][A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b(?:api.?key|credential|password|secret|token)\s*[=:]\s*[^\s,;]+/gi, '[REDACTED]');
  const withoutPaths = withoutCredentialLiterals
    .replace(/"((?:~[\\/]|[A-Za-z]:[\\/]|\\\\(?:\?\\)?(?:UNC\\)?|\/(?!\/))[^"\r\n]+)"/gi, '"[REDACTED_PATH]"')
    .replace(/'((?:~[\\/]|[A-Za-z]:[\\/]|\\\\(?:\?\\)?(?:UNC\\)?|\/(?!\/))[^'\r\n]+)'/gi, "'[REDACTED_PATH]'")
    .replace(/`((?:~[\\/]|[A-Za-z]:[\\/]|\\\\(?:\?\\)?(?:UNC\\)?|\/(?!\/))[^`\r\n]+)`/gi, '`[REDACTED_PATH]`')
    .replace(/<((?:~[\\/]|[A-Za-z]:[\\/]|\\\\(?:\?\\)?(?:UNC\\)?|\/(?!\/))[^>\r\n]+)>/gi, '<[REDACTED_PATH]>')
    .replace(/\[((?:~[\\/]|[A-Za-z]:[\\/]|\\\\(?:\?\\)?(?:UNC\\)?|\/(?!\/))[^\r\n]*)\]/gi, '[REDACTED_PATH]')
    .replace(/\(((?:~[\\/]|[A-Za-z]:[\\/]|\\\\(?:\?\\)?(?:UNC\\)?|\/(?!\/))[^\r\n]*)\)/gi, '([REDACTED_PATH])')
    .replace(/(?:~[\\/]|[A-Za-z]:[\\/]|\\\\(?:\?\\)?(?:UNC\\)?|(?<![A-Za-z0-9._-])\/(?!\/))(?=[^\r\n"'`<>{}]*[\\s()[\]])[^\r\n"'`<>{}]*/g, '[REDACTED_PATH]')
    .replace(/(?:~[\\/]|[A-Za-z]:[\\/]|\\\\(?:\?\\)?(?:UNC\\)?|(?<![A-Za-z0-9._-])\/(?!\/))[^\s"'`<>{}]+/g, '[REDACTED_PATH]');
  return withoutPaths;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SENSITIVE_KEY = /(?:access.?key|api.?key|authorization|auth(?:entication)?|bearer|client.?secret|connection.?string|cookie|credential|dsn|keyfile|oauth|pass(?:word|phrase)|private.?key|secret|session|signature|signing.?key|token)/i;
const ABSOLUTE_URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/{1,}[^\r\n"'`<>]*/gi;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

function isPathKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return ['path', 'root', 'directory', 'dir'].some((suffix) => normalized.endsWith(suffix))
    || new Set([
      'cwd', 'filename', 'file', 'filepath', 'loadedfrom', 'workdir', 'workingdirectory',
      'homedir', 'tempdir', 'temporarydirectory', 'basedir', 'configfile', 'sourcefile', 'location',
    ]).has(normalized);
}

type GenerationProvenance = Readonly<Record<string, unknown>> & {
  recipeId: string;
  recipeVersion: string;
  recipeChecksum: string;
  promptChecksum: string;
  model: string;
  outputKind: string;
  outputChecksum: string;
  referenceChecksums: readonly string[];
};

function bindGenerationOutputs(
  job: JobClaim,
  artifacts: readonly ProviderSupportArtifact[],
  assets: readonly ProviderBinaryAsset[],
  parsedChecksum: string,
): readonly ProviderSupportArtifact[] {
  return artifacts.map((artifact) => {
    const outputKind = requiredString(artifact.provenance.outputKind);
    const outputChecksum = requiredChecksum(artifact.provenance.outputChecksum);
    if (outputKind || outputChecksum) {
      if (!outputKind || !outputChecksum) throw new GenerationProvenanceError('generation_provenance_output_mismatch');
      const output = assets.find((asset) => asset.kind === outputKind);
      if (!output || prefixedChecksum(output.body) !== outputChecksum) {
        throw new GenerationProvenanceError('generation_provenance_output_mismatch');
      }
      return artifact;
    }
    if (job.stage === 'produce_assets') {
      throw new GenerationProvenanceError('generation_provenance_output_missing');
    }
    return {
      ...artifact,
      provenance: {
        ...artifact.provenance,
        outputKind: 'parsed_output',
        outputChecksum: `sha256:${parsedChecksum}`,
      },
    };
  });
}

function recipeIsBoundToJobPlan(job: JobClaim, provenance: GenerationProvenance): boolean {
  const brief = job.input.brief;
  if (!isRecord(brief) || !isRecord(brief.generationPlan) || !isRecord(brief.generationPlan.recipes)) return false;
  return Object.values(brief.generationPlan.recipes).some((binding) => (
    isRecord(binding)
    && binding.id === provenance.recipeId
    && binding.version === provenance.recipeVersion
    && binding.checksum === provenance.recipeChecksum
  ));
}

interface ExecutionArtifact {
  kind: string;
  body: Uint8Array;
  mediaType?: string;
  inputChecksum: string | null;
  provenance?: Readonly<Record<string, unknown>>;
}

export function actionForStage(stage: WorkflowStage): WorkerAction | null {
  return ACTION_BY_STAGE[stage];
}

export function operationIdempotencyKey(job: JobClaim, action: WorkerAction): string {
  return createHash('sha256').update(`knowledge-bits:${job.packageId}:${action}:v${job.revision}`).digest('hex');
}

export function heartbeatIntervalMs(job: JobClaim): number {
  const leaseDuration = new Date(job.leaseExpiresAt).getTime() - new Date(job.claimedAt).getTime();
  if (!Number.isFinite(leaseDuration) || leaseDuration <= 0) return 1_000;
  return Math.max(1_000, Math.floor(leaseDuration / 3));
}

export function executionDeadlineMs(job: JobClaim, now = new Date()): number {
  const remaining = new Date(job.executionDeadlineAt).getTime() - now.getTime();
  return Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
}

function deadlineWait(now: Date): Extract<ProviderExecution, { kind: 'waiting' }> {
  return {
    kind: 'waiting',
    reason: 'execution_deadline_exceeded',
    retryAt: new Date(now.getTime() + 60_000).toISOString(),
  };
}

function checksum(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function prefixedChecksum(bytes: Uint8Array): string {
  return `sha256:${checksum(bytes)}`;
}

function canonicalJsonBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Execution artifacts reject non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  throw new TypeError(`Execution artifacts reject ${typeof value}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : 'Provider execution failed';
}

const systemScheduler: IntervalScheduler = {
  setInterval(callback, delay) {
    return globalThis.setInterval(() => void callback(), delay);
  },
  clearInterval(handle) {
    globalThis.clearInterval(handle as NodeJS.Timeout);
  },
  setTimeout(callback, delay) {
    return globalThis.setTimeout(() => void callback(), delay);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as NodeJS.Timeout);
  },
};
