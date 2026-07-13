import { createHash } from 'node:crypto';

import type { ArtifactCompleteRequest, JobClaim, JobResult, WorkflowStage } from '@knowledge-bits/contracts';

import type { WorkerEngineClient } from './engine-client.js';
import {
  ProviderNeedsHumanError,
  ProviderWaitingError,
  type ProviderExecution,
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
        await this.reportTypedResult(job, execution, controller.signal);
        return;
      }

      const reportBytes = canonicalJsonBytes({
        action,
        jobId: job.jobId,
        packageId: job.packageId,
        provider: provider.name,
        providerReport: execution.executionReport,
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
      await this.uploadExecutionArtifacts(job, provider.name, execution, reportBytes, controller.signal);
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
    const artifacts: ExecutionArtifact[] = [
      ...(execution.assets ?? []).map((asset) => ({
        kind: asset.kind,
        body: asset.body,
        mediaType: asset.mediaType,
        inputChecksum: asset.inputChecksum,
        provenance: asset.provenance,
      })),
      { kind: 'raw_response', body: execution.rawResponse, inputChecksum: execution.inputChecksum ?? null },
      { kind: 'parsed_output', body: parsedBytes, inputChecksum: rawChecksum },
      { kind: 'execution_report', body: reportBytes, inputChecksum: parsedChecksum },
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
        provenance: {
          action: actionForStage(job.stage),
          idempotencyKey: operationIdempotencyKey(job, actionForStage(job.stage)!),
          jobId: job.jobId,
          ...artifact.provenance,
        },
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
