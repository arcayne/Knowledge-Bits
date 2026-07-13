import { createHash } from 'node:crypto';

import type { ContentCandidate } from '../checks/deterministic.js';

import {
  ProviderNeedsHumanError,
  type MediaProvider,
  type ProviderExecution,
  type ProviderExecutionInput,
} from './types.js';

export type MediaKind = 'hero' | 'infographic' | 'audio';

export interface MediaClient {
  generate(input: {
    content: ContentCandidate;
    inputChecksum: string;
    kinds: readonly MediaKind[];
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<readonly {
    kind: MediaKind;
    mediaType: string;
    bytes: Uint8Array;
    inputChecksum: string;
  }[]>;
}

export class MediaProviderAdapter implements MediaProvider {
  readonly name = 'media';
  readonly capabilities = ['produce_assets'] as const;

  constructor(private readonly options: {
    client: MediaClient;
    context: (input: ProviderExecutionInput) => Promise<{
      passedCheck: boolean;
      content: ContentCandidate;
      contentChecksum: string;
    }>;
    kinds?: readonly MediaKind[];
  }) {}

  async execute(input: ProviderExecutionInput): Promise<ProviderExecution> {
    if (input.action !== 'produce_assets') throw new ProviderNeedsHumanError(`media_unsupported_action:${input.action}`);
    const context = await this.options.context(input);
    if (!context.passedCheck) throw new ProviderNeedsHumanError('media_check_required');
    if (!/^[a-f0-9]{64}$/.test(context.contentChecksum)) {
      throw new ProviderNeedsHumanError('media_content_checksum_invalid');
    }
    const kinds = this.options.kinds ?? ['hero', 'infographic', 'audio'];
    const generated = await this.options.client.generate({
      content: context.content,
      inputChecksum: context.contentChecksum,
      kinds,
      idempotencyKey: input.idempotencyKey,
      signal: input.signal,
    });
    if (generated.length === 0) throw new ProviderNeedsHumanError('media_empty_response');
    if (generated.length !== kinds.length || kinds.some((kind) => generated.filter((asset) => asset.kind === kind).length !== 1)) {
      throw new ProviderNeedsHumanError('media_assets_incomplete');
    }
    if (generated.some((asset) => asset.inputChecksum !== context.contentChecksum)) {
      throw new ProviderNeedsHumanError('media_input_checksum_mismatch');
    }

    const assets = generated.map((asset) => ({
      byteSize: asset.bytes.byteLength,
      checksum: createHash('sha256').update(asset.bytes).digest('hex'),
      inputChecksum: asset.inputChecksum,
      kind: asset.kind,
      mediaType: asset.mediaType,
    }));
    return {
      kind: 'success',
      inputChecksum: context.contentChecksum,
      rawResponse: Buffer.from(JSON.stringify(assets)),
      parsedOutput: { assets },
      assets: generated.map((asset) => ({
        kind: asset.kind,
        mediaType: asset.mediaType,
        body: asset.bytes,
        inputChecksum: asset.inputChecksum,
      })),
      executionReport: {
        assetInputChecksum: context.contentChecksum,
        provider: this.name,
      },
    };
  }
}
