import { z } from 'zod';

import {
  DeliveryPermanentSchemaError,
  DeliveryTransientError,
} from '../delivery.js';
import type {
  DeliveryAdapter,
  DeliveryAdapterInput,
  DeliveryAdapterResponse,
  DeliveryVerificationResponse,
} from './types.js';

const deliveryResponseSchema = z.object({
  externalId: z.string().min(1),
  previewUrl: z.string().url(),
  status: z.enum(['imported', 'already_imported']),
}).strict();

const verificationResponseSchema = z.object({
  matches: z.boolean(),
  url: z.string().url(),
}).strict();

export class HttpDeliveryAdapter implements DeliveryAdapter {
  private readonly baseUrl: string;

  constructor(private readonly options: {
    baseUrl: string;
    token?: string;
    fetch?: typeof fetch;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
  }

  async deliver(input: DeliveryAdapterInput): Promise<DeliveryAdapterResponse> {
    try {
      return deliveryResponseSchema.parse(await this.request('/deliver', input));
    } catch (error) {
      if (error instanceof z.ZodError) throw new DeliveryPermanentSchemaError('delivery_adapter_invalid_response_schema');
      throw error;
    }
  }

  async verify(input: { externalId: string; packageChecksum: string }): Promise<DeliveryVerificationResponse> {
    try {
      return verificationResponseSchema.parse(await this.request('/verify', input));
    } catch (error) {
      if (error instanceof z.ZodError) throw new DeliveryPermanentSchemaError('delivery_adapter_invalid_verification_schema');
      throw error;
    }
  }

  private async request(path: string, body: unknown): Promise<unknown> {
    const response = await (this.options.fetch ?? fetch)(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const responseText = await response.text();
    if (!response.ok) {
      const message = `delivery_adapter_${response.status}${responseText ? `:${responseText}` : ''}`;
      if (response.status === 400 || response.status === 409 || response.status === 422) {
        throw new DeliveryPermanentSchemaError(message);
      }
      throw new DeliveryTransientError(message);
    }
    try {
      return JSON.parse(responseText) as unknown;
    } catch {
      throw new DeliveryPermanentSchemaError('delivery_adapter_invalid_json');
    }
  }
}

export function createHttpDeliveryAdapterFromEnv(env: NodeJS.ProcessEnv): HttpDeliveryAdapter {
  const baseUrl = env.DELIVERY_ADAPTER_URL?.trim();
  if (!baseUrl) throw new Error('DELIVERY_ADAPTER_URL is required');
  return new HttpDeliveryAdapter({ baseUrl, token: env.DELIVERY_ADAPTER_TOKEN?.trim() });
}
