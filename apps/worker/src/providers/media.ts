import { createHash } from 'node:crypto';

import type { ContentCandidate } from '../checks/deterministic.js';
import type { NugletGenerationPlan, NugletMediaBaseline } from '@knowledge-bits/contracts';
import type { ResolvedNugletRecipes, ResolvedRecipe } from '../recipes/types.js';

import {
  ProviderNeedsHumanError,
  type MediaProvider,
  type ProviderExecution,
  type ProviderExecutionInput,
  type ProviderSupportArtifact,
} from './types.js';

export type MediaKind =
  | 'hero'
  | 'infographic'
  | 'audio_brief'
  | 'audio_discussion';

export const REQUIRED_MEDIA_KINDS = [
  'hero',
  'infographic',
  'audio_brief',
  'audio_discussion',
] as const satisfies readonly MediaKind[];

export type MediaRecipes = Pick<
  ResolvedNugletRecipes,
  'hero' | 'infographic' | 'audioBrief' | 'audioDiscussion'
>;

export type GeneratedMedia = {
  kind: MediaKind;
  mediaType: string;
  bytes: Uint8Array;
  generationInputChecksum: string;
  metadata: Record<string, unknown>;
  supportArtifacts: readonly ProviderSupportArtifact[];
};

export interface MediaClient {
  generate(input: {
    content: ContentCandidate;
    generationInputChecksum: string;
    kinds: readonly MediaKind[];
    idempotencyKey: string;
    heroDirection: NugletGenerationPlan['heroDirection'];
    mediaBaseline: NugletMediaBaseline;
    resolvedRecipes: MediaRecipes;
    executionInput: ProviderExecutionInput;
    signal: AbortSignal;
  }): Promise<readonly GeneratedMedia[]>;
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
      generationPlan?: NugletGenerationPlan;
      resolvedRecipes?: Partial<ResolvedNugletRecipes>;
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
    const kinds = this.options.kinds ?? REQUIRED_MEDIA_KINDS;
    assertExactRequiredKinds(kinds);
    const generation = requiredMediaGenerationContext(context.generationPlan, context.resolvedRecipes);
    const generated = await this.options.client.generate({
      content: context.content,
      generationInputChecksum: context.contentChecksum,
      kinds,
      idempotencyKey: input.idempotencyKey,
      heroDirection: generation.plan.heroDirection,
      mediaBaseline: generation.plan.mediaBaseline,
      resolvedRecipes: generation.recipes,
      executionInput: input,
      signal: input.signal,
    });
    if (generated.length === 0) throw new ProviderNeedsHumanError('media_empty_response');
    if (generated.length !== kinds.length || kinds.some((kind) => generated.filter((asset) => asset.kind === kind).length !== 1)) {
      throw new ProviderNeedsHumanError('media_assets_incomplete');
    }
    if (generated.some((asset) => asset.generationInputChecksum !== context.contentChecksum)) {
      throw new ProviderNeedsHumanError('media_input_checksum_mismatch');
    }
    for (const asset of generated) validateGeneratedMedia(asset, generation.recipes, generation.plan.mediaBaseline);
    assertDistinctAudioBytes(generated);

    const assets = generated.map((asset) => ({
      byteSize: asset.bytes.byteLength,
      checksum: createHash('sha256').update(asset.bytes).digest('hex'),
      generationInputChecksum: asset.generationInputChecksum,
      kind: asset.kind,
      mediaType: asset.mediaType,
      metadata: asset.metadata,
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
        inputChecksum: asset.generationInputChecksum,
        provenance: asset.metadata,
      })),
      supportArtifacts: generated.flatMap((asset) => asset.supportArtifacts),
      executionReport: {
        assetInputChecksum: context.contentChecksum,
        assetKinds: generated.map(({ kind }) => kind),
        provider: this.name,
      },
    };
  }
}

function assertDistinctAudioBytes(generated: readonly GeneratedMedia[]): void {
  const brief = generated.find((asset) => asset.kind === 'audio_brief');
  const discussion = generated.find((asset) => asset.kind === 'audio_discussion');
  if (brief && discussion && prefixedChecksum(brief.bytes) === prefixedChecksum(discussion.bytes)) {
    throw new ProviderNeedsHumanError('media_audio_roles_aliased');
  }
}

function requiredMediaGenerationContext(
  plan: NugletGenerationPlan | undefined,
  recipes: Partial<ResolvedNugletRecipes> | undefined,
): { plan: NugletGenerationPlan; recipes: MediaRecipes } {
  if (plan?.schemaVersion !== '1.1.0') throw new ProviderNeedsHumanError('media_generation_plan_required');
  if (!recipes?.hero || !recipes.infographic || !recipes.audioBrief || !recipes.audioDiscussion) {
    throw new ProviderNeedsHumanError('media_recipes_incomplete');
  }
  return {
    plan,
    recipes: {
      hero: recipes.hero,
      infographic: recipes.infographic,
      audioBrief: recipes.audioBrief,
      audioDiscussion: recipes.audioDiscussion,
    },
  };
}

function assertExactRequiredKinds(kinds: readonly MediaKind[]): void {
  if (kinds.length !== REQUIRED_MEDIA_KINDS.length
    || REQUIRED_MEDIA_KINDS.some((kind) => kinds.filter((candidate) => candidate === kind).length !== 1)) {
    throw new ProviderNeedsHumanError('media_kinds_invalid');
  }
}

function validateGeneratedMedia(asset: GeneratedMedia, recipes: MediaRecipes, baseline: NugletMediaBaseline): void {
  if (!asset.mediaType.trim() || asset.bytes.byteLength === 0 || !isRecord(asset.metadata)) {
    throw new ProviderNeedsHumanError('media_generation_invalid_response');
  }
  if (asset.metadata.byteSize !== asset.bytes.byteLength) {
    throw new ProviderNeedsHumanError('media_metadata_invalid');
  }
  if (asset.kind === 'hero' || asset.kind === 'infographic') {
    const width = positiveInteger(asset.metadata.width);
    const height = positiveInteger(asset.metadata.height);
    if (!width || !height) throw new ProviderNeedsHumanError('media_metadata_invalid');
    if (asset.kind === 'hero' && (width < 1024 || height < 768 || width * 3 !== height * 4)) {
      throw new ProviderNeedsHumanError('media_hero_dimensions_invalid');
    }
  } else {
    const durationSeconds = asset.metadata.durationSeconds;
    const transcript = asset.metadata.transcript;
    const transcriptSource = asset.metadata.transcriptSource;
    const audioChecksum = `sha256:${createHash('sha256').update(asset.bytes).digest('hex')}`;
    if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0
      || typeof transcript !== 'string' || !transcript.trim()
      || (transcriptSource !== 'notebooklm' && transcriptSource !== 'vertex_gemini')
      || asset.metadata.transcriptAudioChecksum !== audioChecksum) {
      throw new ProviderNeedsHumanError('media_audio_metadata_invalid');
    }
  }
  const baselineArtifact = baselineArtifactForKind(baseline, asset.kind);
  if (baselineArtifact && prefixedChecksum(asset.bytes) !== baselineArtifact.checksum) {
    throw new ProviderNeedsHumanError('media_baseline_checksum_mismatch');
  }
  validateSupportArtifacts(asset, recipeForKind(recipes, asset.kind), baselineArtifact);
}

function validateSupportArtifacts(
  asset: GeneratedMedia,
  recipe: ResolvedRecipe,
  baselineArtifact: NugletMediaBaseline['descriptor']['artifacts'][keyof NugletMediaBaseline['descriptor']['artifacts']] | undefined,
): void {
  const minimumPairCount = asset.kind.startsWith('audio_') ? 2 : 1;
  if (asset.supportArtifacts.length < minimumPairCount * 2 || asset.supportArtifacts.length % 2 !== 0) {
    throw new ProviderNeedsHumanError('media_support_evidence_incomplete');
  }
  const expectedReferences = asset.kind === 'hero' ? heroReferenceChecksums(recipe) : [];
  for (let index = 0; index < asset.supportArtifacts.length; index += 2) {
    const recipeArtifact = asset.supportArtifacts[index];
    const promptArtifact = asset.supportArtifacts[index + 1];
    if (!recipeArtifact || !promptArtifact
      || recipeArtifact.kind !== 'generation.recipe.snapshot'
      || promptArtifact.kind !== 'generation.prompt.rendered'
      || !Buffer.from(recipeArtifact.body).equals(Buffer.from(recipe.canonicalBytes))
      || promptArtifact.inputChecksum !== recipe.checksum.replace(/^sha256:/, '')) {
      throw new ProviderNeedsHumanError('media_support_evidence_incomplete');
    }
    for (const support of [recipeArtifact, promptArtifact]) {
      if (support.provenance.recipeId !== recipe.id
        || support.provenance.recipeVersion !== recipe.version
        || support.provenance.recipeChecksum !== recipe.checksum
        || typeof support.provenance.provider !== 'string'
        || !support.provenance.provider.trim()
        || typeof support.provenance.model !== 'string'
        || !support.provenance.model.trim()
        || support.provenance.promptChecksum !== prefixedChecksum(promptArtifact.body)
        || JSON.stringify(support.provenance.referenceChecksums) !== JSON.stringify(expectedReferences)) {
        throw new ProviderNeedsHumanError('media_support_evidence_mismatch');
      }
    }
    if (JSON.stringify(recipeArtifact.provenance) !== JSON.stringify(promptArtifact.provenance)) {
      throw new ProviderNeedsHumanError('media_support_evidence_mismatch');
    }
  }
  if (baselineArtifact) {
    validateExpectedExecutionPair(asset.supportArtifacts, 0, baselineArtifact.generation);
    if (asset.kind.startsWith('audio_')) {
      const transcriptSource = asset.metadata.transcriptSource;
      if (transcriptSource === 'notebooklm') {
        if (!('transcript' in baselineArtifact) || !baselineArtifact.transcript) {
          throw new ProviderNeedsHumanError('media_transcript_evidence_mismatch');
        }
        validateExpectedExecutionPair(asset.supportArtifacts, 1, baselineArtifact.transcript.extraction);
      } else if (('transcript' in baselineArtifact) && baselineArtifact.transcript) {
        throw new ProviderNeedsHumanError('media_transcript_evidence_mismatch');
      } else if (asset.supportArtifacts[2]?.provenance.provider !== 'vertex') {
        throw new ProviderNeedsHumanError('media_transcript_evidence_mismatch');
      }
    }
  }
}

function validateExpectedExecutionPair(
  artifacts: readonly ProviderSupportArtifact[],
  pairIndex: number,
  evidence: NugletMediaBaseline['descriptor']['artifacts']['infographic']['generation'],
): void {
  const recipeArtifact = artifacts[pairIndex * 2];
  const promptArtifact = artifacts[(pairIndex * 2) + 1];
  const expectedPrompt = Buffer.from(evidence.prompt.bytesBase64, 'base64');
  if (!recipeArtifact || !promptArtifact
    || !Buffer.from(promptArtifact.body).equals(expectedPrompt)
    || promptArtifact.provenance.promptChecksum !== evidence.prompt.checksum
    || promptArtifact.provenance.provider !== evidence.provider
    || promptArtifact.provenance.model !== evidence.model
    || promptArtifact.provenance.artifactId !== evidence.artifactId
    || promptArtifact.provenance.notebookId !== evidence.notebookId) {
    throw new ProviderNeedsHumanError('media_support_evidence_mismatch');
  }
}

function baselineArtifactForKind(
  baseline: NugletMediaBaseline,
  kind: MediaKind,
): NugletMediaBaseline['descriptor']['artifacts'][keyof NugletMediaBaseline['descriptor']['artifacts']] | undefined {
  if (kind === 'infographic') return baseline.descriptor.artifacts.infographic;
  if (kind === 'audio_brief') return baseline.descriptor.artifacts.audioBrief;
  if (kind === 'audio_discussion') return baseline.descriptor.artifacts.audioDiscussion;
  return undefined;
}

function prefixedChecksum(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function heroReferenceChecksums(recipe: ResolvedRecipe): readonly string[] {
  const references = recipe.value.referenceAssets;
  if (!Array.isArray(references)) throw new ProviderNeedsHumanError('media_hero_references_invalid');
  const checksums = references.map((reference) => (
    isRecord(reference) && typeof reference.checksum === 'string' && /^sha256:[a-f0-9]{64}$/.test(reference.checksum)
      ? reference.checksum
      : undefined
  ));
  if (checksums.some((checksum) => checksum === undefined)) {
    throw new ProviderNeedsHumanError('media_hero_references_invalid');
  }
  return checksums as string[];
}

export function recipeForKind(recipes: MediaRecipes, kind: MediaKind): ResolvedRecipe {
  if (kind === 'hero') return recipes.hero;
  if (kind === 'infographic') return recipes.infographic;
  if (kind === 'audio_brief') return recipes.audioBrief;
  return recipes.audioDiscussion;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
