import type {
  DeliveryAdapter,
  DeliveryAdapterInput,
  DeliveryAdapterResponse,
  DeliveryVerificationResponse,
} from './types.js';

export class FixtureDeliveryAdapter implements DeliveryAdapter {
  readonly requests: DeliveryAdapterInput[] = [];
  readonly responses = new Map<string, DeliveryAdapterResponse>();
  verifyMatches = true;

  async deliver(input: DeliveryAdapterInput): Promise<DeliveryAdapterResponse> {
    this.requests.push(structuredClone(input));
    const existing = this.responses.get(input.idempotencyKey);
    if (existing) return { ...existing, status: 'already_imported' };
    const response: DeliveryAdapterResponse = {
      externalId: `fixture-${input.packageVersionId}`,
      previewUrl: `https://fixture.delivery.invalid/${input.packageVersionId}`,
      status: 'imported',
    };
    this.responses.set(input.idempotencyKey, response);
    return response;
  }

  async verify(input: { externalId: string; packageChecksum: string }): Promise<DeliveryVerificationResponse> {
    return {
      matches: this.verifyMatches,
      url: `https://fixture.delivery.invalid/${input.externalId}`,
    };
  }
}
