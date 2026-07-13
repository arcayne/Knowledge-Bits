import type { WorkflowRepository } from '../repositories/workflow-repository.js';
import type {
  DeliveryAdapter,
  ImmutableApprovedKnowledgeBits,
} from './delivery-adapters/types.js';

export type DeliveryRunResult =
  | { state: 'succeeded'; packageChecksum: string }
  | { state: 'waiting' | 'failed'; packageChecksum: string; error: string; retryAt: Date }
  | { state: 'needs_human'; packageChecksum: string; error: string };

export class DeliveryService {
  private readonly clock: () => Date;

  constructor(private readonly dependencies: {
    repository: WorkflowRepository;
    adapter: DeliveryAdapter;
    clock?: () => Date;
    retryDelayMs?: number;
  }) {
    this.clock = dependencies.clock ?? (() => new Date());
  }

  async run(deliveryId: string): Promise<DeliveryRunResult> {
    const delivery = await this.dependencies.repository.getDelivery(deliveryId);
    if (!delivery) throw new DeliveryNotFoundError('Delivery not found');
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

    await this.dependencies.repository.updateDelivery({
      id: delivery.id,
      state: 'running',
      incrementAttempts: true,
      nextAttemptAt: null,
    });
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

    try {
      const response = await this.dependencies.adapter.deliver({
        knowledgeBits,
        packageVersionId: packageVersion.id,
        packageChecksum: packageVersion.packageChecksum,
        idempotencyKey: delivery.idempotencyKey,
      });
      await this.dependencies.repository.updateDelivery({
        id: delivery.id,
        state: 'verifying',
        response: response as unknown as Record<string, unknown>,
        nextAttemptAt: null,
      });
      const verification = await this.dependencies.adapter.verify({
        externalId: response.externalId,
        packageChecksum: packageVersion.packageChecksum,
      });
      if (!verification.matches) {
        const retryAt = this.retryAt();
        await this.dependencies.repository.updateDelivery({
          id: delivery.id,
          state: 'failed',
          response: { ...response, verification },
          nextAttemptAt: retryAt,
        });
        return { state: 'failed', packageChecksum: delivery.packageChecksum, error: 'delivery_verification_mismatch', retryAt };
      }
      await this.dependencies.repository.updateDelivery({
        id: delivery.id,
        state: 'succeeded',
        response: { ...response, verification },
        nextAttemptAt: null,
      });
      return { state: 'succeeded', packageChecksum: delivery.packageChecksum };
    } catch (error) {
      const persisted = await this.dependencies.repository.getDelivery(delivery.id);
      const response = { ...(persisted?.response ?? {}), error: errorMessage(error) };
      if (error instanceof DeliveryPermanentSchemaError) {
        await this.dependencies.repository.updateDelivery({
          id: delivery.id,
          state: 'needs_human',
          response: { ...response, kind: 'permanent_schema' },
          nextAttemptAt: null,
        });
        return { state: 'needs_human', packageChecksum: delivery.packageChecksum, error: error.message };
      }
      const retryAt = this.retryAt();
      const message = errorMessage(error);
      await this.dependencies.repository.updateDelivery({
        id: delivery.id,
        state: 'waiting',
        response: { ...response, kind: error instanceof DeliveryTransientError ? 'transient' : 'adapter_error' },
        nextAttemptAt: retryAt,
      });
      return { state: 'waiting', packageChecksum: delivery.packageChecksum, error: message, retryAt };
    }
  }

  private retryAt(): Date {
    return new Date(this.clock().getTime() + (this.dependencies.retryDelayMs ?? 60_000));
  }
}

export class DeliveryNotFoundError extends Error {}
export class DeliveryConflictError extends Error {}
export class DeliveryTransientError extends Error {}
export class DeliveryPermanentSchemaError extends Error {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
