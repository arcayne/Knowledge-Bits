import { createHash } from 'node:crypto';

import {
  knowledgeBitsContentSchema,
  knowledgeBitsSchema,
  nugletGenerationInputSchema,
  nugletGenerationPlanSchema,
  type ArtifactReference,
  type KnowledgeBits,
  type KnowledgeBitsContent,
  type KnowledgeBitsEvidence,
  type KnowledgeBitsQa,
  type NugletLessonTarget,
  type NugletLessonV1Payload,
  type NugletGenerationInput,
  type NugletGenerationPlan,
} from '@knowledge-bits/contracts';

type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface KnowledgeBitsChecksumInput {
  content: KnowledgeBitsContent;
  evidence: KnowledgeBitsEvidence;
  qa: KnowledgeBitsQa;
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
    content: packageChecksumContentRepresentation(input.content),
    evidence: input.evidence,
    qa: input.qa,
    locale: input.locale,
    owner: input.owner,
    usageRights: input.usageRights,
  };

  return createHash('sha256').update(canonicalJson(checksumMaterial)).digest('hex');
}

export function packageChecksumContentRepresentation(content: KnowledgeBitsContent): unknown {
  if (!isPlainObject(content) || !isPlainObject(content.target)) return content;
  if (
    content.target.kind !== 'nuglet.lesson.v1'
    || !('schemaVersion' in content.target)
    || content.target.schemaVersion !== '1.0.0'
  ) {
    if ('schemaVersion' in content.target && content.target.schemaVersion === '1.1.0') {
      return {
        content,
        contentChecksum: calculateContentChecksum(content.target),
      };
    }
    return content;
  }

  const { schemaVersion: _schemaVersion, ...legacyTarget } = content.target;
  return { ...content, target: legacyTarget };
}

export function canonicalNugletGenerationInput(input: {
  semanticTarget: unknown;
  generationPlan: NugletGenerationPlan;
}): NugletGenerationInput {
  const generationPlan = nugletGenerationPlanSchema.parse(input.generationPlan);
  return nugletGenerationInputSchema.parse({
    schemaVersion: 'knowledge-bits.generation-input.v1',
    semanticTarget: input.semanticTarget,
    media: {
      recipes: {
        hero: generationPlan.recipes.hero,
        infographic: generationPlan.recipes.infographic,
        audioBrief: generationPlan.recipes.audioBrief,
        audioDiscussion: generationPlan.recipes.audioDiscussion,
      },
      heroDirection: generationPlan.heroDirection,
      ...(generationPlan.mediaBaseline ? { mediaBaseline: generationPlan.mediaBaseline } : {}),
    },
  });
}

export function calculateNugletGenerationInputChecksum(input: {
  semanticTarget: unknown;
  generationPlan: NugletGenerationPlan;
}): string {
  return createHash('sha256').update(canonicalJson(canonicalNugletGenerationInput(input))).digest('hex');
}

export function calculateLegacyContentChecksum(content: NugletLessonV1Payload): string {
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

export function calculateContentChecksum(content: unknown): string {
  if (isNugletLessonTarget(content)) {
    if (content.schemaVersion === '1.0.0') return calculateLegacyContentChecksum(content.payload);
    return createHash('sha256').update(canonicalJson(content)).digest('hex');
  }

  if (isBareStoryPlaybookPayload(content)) {
    throw new TypeError('Schema 1.1.0 content checksum requires the full versioned target envelope');
  }
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

export function calculateSocialPostChecksum(socialPost: unknown): string {
  return createHash('sha256').update(canonicalJson(socialPost)).digest('hex');
}

export function buildKnowledgeBits(input: BuildKnowledgeBitsInput): KnowledgeBits {
  const content = knowledgeBitsContentSchema.parse(input.content);
  const packageChecksum = calculatePackageChecksum({ ...input, content });
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
    target: content.target,
    surfaces: input.surfaces,
    evidence: input.evidence,
    qa: input.qa,
    packageChecksum,
    approval,
  });
}

export function canonicalJson(value: unknown): string {
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
        if (Object.getPrototypeOf(value) !== Array.prototype) {
          throw new TypeError('Canonical JSON accepts only plain arrays');
        }

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

function isNugletLessonTarget(value: unknown): value is NugletLessonTarget {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && 'kind' in value
    && 'schemaVersion' in value
    && 'payload' in value;
}

function isBareStoryPlaybookPayload(value: unknown): boolean {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && 'contentModel' in value
    && value.contentModel === 'story-playbook.v1';
}
