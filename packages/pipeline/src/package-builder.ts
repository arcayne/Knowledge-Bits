import { createHash } from 'node:crypto';

import {
  knowledgeBitsSchema,
  type ArtifactReference,
  type KnowledgeBits,
  type KnowledgeBitsContent,
  type KnowledgeBitsEvidence,
} from '@knowledge-bits/contracts';

type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface KnowledgeBitsChecksumInput {
  content: KnowledgeBitsContent;
  evidence: KnowledgeBitsEvidence;
  assetInventory: readonly ArtifactReference[];
  adapterVersion: string;
  locale: string;
  owner: string;
  usageRights: JsonValue;
}

export interface BuildKnowledgeBitsInput extends KnowledgeBitsChecksumInput {
  packageId: string;
  revision: number;
  riskClass: KnowledgeBits['riskClass'];
  surfaces: KnowledgeBits['surfaces'];
  approval?: KnowledgeBits['approval'];
}

export function calculatePackageChecksum(input: KnowledgeBitsChecksumInput): string {
  const checksumMaterial = {
    adapterVersion: input.adapterVersion,
    assetInventory: input.assetInventory,
    content: input.content,
    evidence: input.evidence,
    locale: input.locale,
    owner: input.owner,
    usageRights: input.usageRights,
  };

  return createHash('sha256').update(canonicalJson(checksumMaterial)).digest('hex');
}

export function buildKnowledgeBits(input: BuildKnowledgeBitsInput): KnowledgeBits {
  const packageChecksum = calculatePackageChecksum(input);
  const approval = input.approval ?? {
    status: 'unapproved' as const,
    reviewerId: null,
    decidedAt: null,
    approvedChecksum: null,
    comment: null,
  };

  return knowledgeBitsSchema.parse({
    schemaVersion: 'knowledge-bits.package.v1',
    packageId: input.packageId,
    revision: input.revision,
    locale: input.locale,
    owner: input.owner,
    riskClass: input.riskClass,
    target: input.content.target,
    surfaces: input.surfaces,
    evidence: input.evidence,
    packageChecksum,
    approval,
  });
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('Canonical JSON rejects non-finite numbers');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'undefined':
      throw new TypeError('Canonical JSON rejects undefined values');
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new TypeError(`Canonical JSON rejects ${typeof value} values`);
    case 'object':
      if (Array.isArray(value)) {
        const items = Array.from({ length: value.length }, (_, index) => {
          if (!Object.hasOwn(value, index)) {
            throw new TypeError('Canonical JSON rejects sparse arrays');
          }

          return canonicalJson(value[index]);
        });

        return `[${items.join(',')}]`;
      }

      if (!isPlainObject(value)) {
        throw new TypeError('Canonical JSON accepts only plain objects');
      }

      return `{${Object.keys(value).sort().map((key) => (
        `${JSON.stringify(key)}:${canonicalJson(value[key as keyof typeof value])}`
      )).join(',')}}`;
  }

  throw new TypeError('Canonical JSON received an unsupported value');
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
