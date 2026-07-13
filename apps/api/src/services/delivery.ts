import {
  WorkflowConflictError,
  type WorkflowDelivery,
  type WorkflowRepository,
} from '../repositories/workflow-repository.js';
import type {
  DeliveryAdapter,
  DeliveryAdapterResponse,
  ImmutableApprovedKnowledgeBits,
} from './delivery-adapters/types.js';

export type DeliveryRunResult =
  | { state: 'succeeded'; packageChecksum: string }
  | { state: 'waiting' | 'failed'; packageChecksum: string; error: string; retryAt: Date }
  | { state: 'needs_human'; packageChecksum: string; error: string };

export interface DeliveryExecutionContext {
  jobId: string;
  workerId: string;
}

export type DeliveryBoundary = 'running' | 'delivered' | 'verifying' | 'succeeded';

export class DeliveryService {
  private readonly clock: () => Date;

  constructor(private readonly dependencies: {
    repository: WorkflowRepository;
    adapter: DeliveryAdapter;
    clock?: () => Date;
    retryDelayMs?: number;
    timeoutMs?: number;
    onBoundary?: (boundary: DeliveryBoundary) => void;
  }) {
    this.clock = dependencies.clock ?? (() => new Date());
  }

  async run(
    deliveryId: string,
    execution: DeliveryExecutionContext,
    callerSignal?: AbortSignal,
  ): Promise<DeliveryRunResult> {
    const initialDelivery = await this.dependencies.repository.getDelivery(deliveryId);
    if (!initialDelivery) throw new DeliveryNotFoundError('Delivery not found');
    let delivery: WorkflowDelivery = initialDelivery;
    if (delivery.state === 'needs_human' || delivery.state === 'superseded') {
      throw new DeliveryConflictError(`Delivery cannot be run from state ${delivery.state}`);
    }
    if (!['queued', 'waiting', 'failed', 'running', 'verifying', 'succeeded'].includes(delivery.state)) {
      throw new DeliveryConflictError(`Delivery cannot be run from state ${delivery.state}`);
    }
    const packageVersion = await this.dependencies.repository.getPackageVersionById(delivery.packageVersionId);
    if (!packageVersion
      || packageVersion.runId !== delivery.runId
      || packageVersion.packageChecksum !== delivery.packageChecksum) {
      throw new DeliveryConflictError('Delivery immutable package identity does not match');
    }
    const [run, review] = await Promise.all([
      this.dependencies.repository.getRun(delivery.runId),
      this.dependencies.repository.getReview(delivery.runId, delivery.packageChecksum),
    ]);
    if (!run
      || run.packageChecksum !== delivery.packageChecksum
      || run.approvedChecksum !== delivery.packageChecksum
      || review?.decision !== 'approve') {
      throw new DeliveryConflictError('Delivery requires a matching current approved checksum');
    }

    if (delivery.state === 'succeeded') {
      return { state: 'succeeded', packageChecksum: delivery.packageChecksum };
    }

    const transition = async (
      expectedState: string,
      state: string,
      options: {
        response?: Record<string, unknown>;
        nextAttemptAt?: Date | null;
        incrementAttempts?: boolean;
      } = {},
    ) => {
      delivery = await this.dependencies.repository.transitionDeliveryForActiveLease({
        id: delivery.id,
        jobId: execution.jobId,
        workerId: execution.workerId,
        packageVersionId: delivery.packageVersionId,
        packageChecksum: delivery.packageChecksum,
        expectedState,
        state,
        now: this.clock(),
        ...options,
      });
      return delivery;
    };
    const knowledgeBits: ImmutableApprovedKnowledgeBits = {
      id: packageVersion.id,
      schemaVersion: 'knowledge-bits.review-package.v1',
      packageId: packageVersion.runId,
      revision: packageVersion.revision,
      packageChecksum: packageVersion.packageChecksum,
      adapterVersion: packageVersion.adapterVersion,
      locale: packageVersion.locale,
      owner: packageVersion.owner,
      usageRights: packageVersion.usageRights,
      content: packageVersion.content,
      evidence: packageVersion.evidence,
      qa: packageVersion.qa,
      artifactInventory: packageVersion.artifactInventory,
      approval: {
        status: 'approved',
        reviewerId: review.reviewerId,
        decidedAt: review.createdAt.toISOString(),
        approvedChecksum: review.packageChecksum,
        comment: null,
      },
    };
    const timeoutSignal = AbortSignal.timeout(this.dependencies.timeoutMs ?? 30_000);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;

    let expectedState = delivery.state;
    try {
      let response = deliveryResponse(delivery);
      if (delivery.state === 'queued' || ((delivery.state === 'waiting' || delivery.state === 'failed') && !response)) {
        await transition(delivery.state, 'running', { incrementAttempts: true, nextAttemptAt: null });
        expectedState = 'running';
        this.boundary('running');
      } else if ((delivery.state === 'waiting' || delivery.state === 'failed') && response) {
        await transition(delivery.state, 'verifying', { incrementAttempts: true, nextAttemptAt: null });
        expectedState = 'verifying';
        this.boundary('verifying');
      }

      if (expectedState === 'running') {
        response = await this.dependencies.adapter.deliver({
          knowledgeBits,
          packageVersionId: packageVersion.id,
          packageChecksum: packageVersion.packageChecksum,
          idempotencyKey: delivery.idempotencyKey,
        }, signal);
        this.boundary('delivered');
        await transition('running', 'verifying', {
          response: response as unknown as Record<string, unknown>,
          nextAttemptAt: null,
        });
        expectedState = 'verifying';
        this.boundary('verifying');
      }

      response ??= deliveryResponse(delivery);
      if (expectedState !== 'verifying' || !response) {
        throw new DeliveryConflictError('Delivery verification requires a persisted adapter response');
      }
      const verification = await this.dependencies.adapter.verify({
        externalId: response.externalId,
        packageChecksum: packageVersion.packageChecksum,
      }, signal);
      if (!verification.matches) {
        const retryAt = this.retryAt();
        await transition('verifying', 'failed', {
          response: { ...response, verification },
          nextAttemptAt: retryAt,
        });
        return { state: 'failed', packageChecksum: delivery.packageChecksum, error: 'delivery_verification_mismatch', retryAt };
      }
      await transition('verifying', 'succeeded', {
        response: { ...response, verification },
        nextAttemptAt: null,
      });
      this.boundary('succeeded');
      return { state: 'succeeded', packageChecksum: delivery.packageChecksum };
    } catch (error) {
      if (error instanceof DeliveryProcessInterruptionError
        || error instanceof WorkflowConflictError
        || error instanceof DeliveryConflictError) throw error;
      const persisted = await this.dependencies.repository.getDelivery(delivery.id);
      expectedState = persisted?.state ?? expectedState;
      const response = { ...(persisted?.response ?? {}), error: timeoutMessage(error, timeoutSignal, callerSignal) };
      if (error instanceof DeliveryPermanentSchemaError) {
        await transition(expectedState, 'needs_human', {
          response: { ...response, kind: 'permanent_schema' },
          nextAttemptAt: null,
        });
        return { state: 'needs_human', packageChecksum: delivery.packageChecksum, error: error.message };
      }
      const retryAt = this.retryAt();
      const message = timeoutMessage(error, timeoutSignal, callerSignal);
      await transition(expectedState, 'waiting', {
        response: {
          ...response,
          kind: timeoutSignal.aborted && !callerSignal?.aborted
            ? 'timeout'
            : error instanceof DeliveryTransientError ? 'transient' : 'adapter_error',
        },
        nextAttemptAt: retryAt,
      });
      return { state: 'waiting', packageChecksum: delivery.packageChecksum, error: message, retryAt };
    }
  }

  private boundary(boundary: DeliveryBoundary): void {
    this.dependencies.onBoundary?.(boundary);
  }

  private retryAt(): Date {
    return new Date(this.clock().getTime() + (this.dependencies.retryDelayMs ?? 60_000));
  }
}

export class DeliveryNotFoundError extends Error {}
export class DeliveryConflictError extends Error {}
export class DeliveryTransientError extends Error {}
export class DeliveryPermanentSchemaError extends Error {}
export class DeliveryProcessInterruptionError extends Error {}

function deliveryResponse(delivery: WorkflowDelivery): DeliveryAdapterResponse | undefined {
  const response = delivery.response;
  if (!response
    || typeof response.externalId !== 'string'
    || typeof response.previewUrl !== 'string'
    || (response.status !== 'imported' && response.status !== 'already_imported')) return undefined;
  return {
    externalId: response.externalId,
    previewUrl: response.previewUrl,
    status: response.status,
  };
}

function timeoutMessage(error: unknown, timeoutSignal: AbortSignal, callerSignal?: AbortSignal): string {
  if (timeoutSignal.aborted && !callerSignal?.aborted) return 'delivery_timeout';
  return error instanceof Error ? error.message : String(error);
}
