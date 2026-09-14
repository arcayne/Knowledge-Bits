import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DeliveryPermanentSchemaError } from '../delivery.js';
import type {
  DeliveryAdapter,
  DeliveryAdapterInput,
  DeliveryAdapterResponse,
  DeliveryVerificationResponse,
} from './types.js';
import { createHttpDeliveryAdapterFromEnv } from './http.js';

export interface LocalDeliveryAdapterConfig {
  root: string;
}

interface LocalDeliveryReceipt {
  idempotencyKey: string;
  packageVersionId: string;
  packageChecksum: string;
  externalId: string;
  previewUrl: string;
  deliveredAt: string;
}

const RECEIPT_DIRECTORY = 'delivery-receipts';

/** Persists local delivery receipts without calling an external destination. */
export class LocalDeliveryAdapter implements DeliveryAdapter {
  private readonly root: string;
  private readonly receiptRoot: string;

  constructor(config: LocalDeliveryAdapterConfig) {
    if (!config.root.trim()) throw new Error('Local delivery filesystem root is required');
    this.root = resolve(config.root);
    this.receiptRoot = join(this.root, RECEIPT_DIRECTORY);
  }

  async deliver(input: DeliveryAdapterInput): Promise<DeliveryAdapterResponse> {
    if (!input.idempotencyKey || !input.packageChecksum || !input.packageVersionId) {
      throw new DeliveryPermanentSchemaError('local_delivery_invalid_identity');
    }
    await mkdir(this.receiptRoot, { recursive: true });
    const receiptPath = this.receiptPath(input.idempotencyKey);
    const existing = await this.readReceipt(receiptPath);
    if (existing) {
      this.assertSameImport(existing, input);
      return {
        externalId: existing.externalId,
        previewUrl: existing.previewUrl,
        status: 'already_imported',
      };
    }

    const identity = createHash('sha256').update(input.idempotencyKey).digest('hex');
    const receipt: LocalDeliveryReceipt = {
      idempotencyKey: input.idempotencyKey,
      packageVersionId: input.packageVersionId,
      packageChecksum: input.packageChecksum,
      externalId: `local-${identity}`,
      previewUrl: pathToFileURL(receiptPath).toString(),
      deliveredAt: new Date().toISOString(),
    };
    const temporaryPath = `${receiptPath}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporaryPath, 'wx');
      try {
        await handle.writeFile(JSON.stringify(receipt, null, 2));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(temporaryPath, receiptPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new DeliveryPermanentSchemaError('local_delivery_receipt_write_failed');
      }
      const raced = await this.readReceipt(receiptPath);
      if (!raced) throw new DeliveryPermanentSchemaError('local_delivery_receipt_invalid');
      this.assertSameImport(raced, input);
      return {
        externalId: raced.externalId,
        previewUrl: raced.previewUrl,
        status: 'already_imported',
      };
    } finally {
      await rm(temporaryPath, { force: true });
    }
    return {
      externalId: receipt.externalId,
      previewUrl: receipt.previewUrl,
      status: 'imported',
    };
  }

  async verify(input: { externalId: string; packageChecksum: string }): Promise<DeliveryVerificationResponse> {
    await mkdir(this.receiptRoot, { recursive: true });
    const entries = await readdir(this.receiptRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const receipt = await this.readReceipt(join(this.receiptRoot, entry.name));
      if (!receipt || receipt.externalId !== input.externalId) continue;
      return {
        matches: receipt.packageChecksum === input.packageChecksum,
        url: receipt.previewUrl,
      };
    }
    return {
      matches: false,
      url: pathToFileURL(this.receiptRoot).toString(),
    };
  }

  receiptPath(idempotencyKey: string): string {
    const digest = createHash('sha256').update(idempotencyKey).digest('hex');
    return join(this.receiptRoot, `${digest}.json`);
  }

  private async readReceipt(path: string): Promise<LocalDeliveryReceipt | undefined> {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<LocalDeliveryReceipt>;
      if (typeof parsed.idempotencyKey !== 'string'
        || typeof parsed.packageVersionId !== 'string'
        || typeof parsed.packageChecksum !== 'string'
        || typeof parsed.externalId !== 'string'
        || typeof parsed.previewUrl !== 'string'
        || typeof parsed.deliveredAt !== 'string') {
        throw new Error('Invalid local delivery receipt');
      }
      return parsed as LocalDeliveryReceipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof DeliveryPermanentSchemaError) throw error;
      throw new DeliveryPermanentSchemaError('local_delivery_receipt_invalid');
    }
  }

  private assertSameImport(receipt: LocalDeliveryReceipt, input: DeliveryAdapterInput): void {
    if (receipt.idempotencyKey !== input.idempotencyKey
      || receipt.packageChecksum !== input.packageChecksum
      || receipt.packageVersionId !== input.packageVersionId) {
      throw new DeliveryPermanentSchemaError('local_delivery_checksum_mismatch');
    }
  }
}

export function createDeliveryAdapterFromEnv(env: NodeJS.ProcessEnv): DeliveryAdapter | undefined {
  const mode = env.DELIVERY_ADAPTER_MODE?.trim();
  if (mode === 'local') {
    // The artifact root is an explicit local-demo fallback when a separate destination root is not set.
    const configuredRoot = env.DELIVERY_ADAPTER_FILESYSTEM_ROOT?.trim();
    const root = configuredRoot || env.ARTIFACT_STORAGE_FILESYSTEM_ROOT?.trim();
    if (!root) {
      throw new Error('DELIVERY_ADAPTER_MODE=local requires: DELIVERY_ADAPTER_FILESYSTEM_ROOT');
    }
    return new LocalDeliveryAdapter({ root });
  }
  return createHttpDeliveryAdapterFromEnv(env);
}

export { LocalDeliveryAdapter as LocalFilesystemDeliveryAdapter };
