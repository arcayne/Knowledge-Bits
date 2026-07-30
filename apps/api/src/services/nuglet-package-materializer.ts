import { createHash } from 'node:crypto';

import {
  artifactReferenceSchema,
  knowledgeBitsContentSchema,
  nugletGenerationPlanSchema,
  nugletNarrativeDraftSchema,
  nugletNarrativeGenerationPlanSchema,
  storyPlaybookDraftSchema,
  type ArtifactReference,
  type NugletGenerationPlan,
  type NugletLessonTarget,
  type NugletNarrativeGenerationPlan,
  type NugletNarrativeTarget,
} from '@knowledge-bits/contracts';
import {
  calculateNugletGenerationInputChecksum,
  calculateNugletNarrativeGenerationInputChecksum,
} from '@knowledge-bits/pipeline';

import type { WorkflowArtifact } from '../repositories/workflow-repository.js';

export const NUGLET_REVIEW_MEDIA_KINDS = [
  'hero',
  'infographic',
  'audio_brief',
  'audio_discussion',
] as const;

export const NUGLET_NARRATIVE_REVIEW_MEDIA_KINDS = [
  'hero',
  'infographic',
  'audio_conversation',
] as const;

export type NugletReviewMediaKind =
  | typeof NUGLET_REVIEW_MEDIA_KINDS[number]
  | typeof NUGLET_NARRATIVE_REVIEW_MEDIA_KINDS[number];
export type NugletReviewMediaArtifacts = Partial<Record<NugletReviewMediaKind, WorkflowArtifact>>;
export type StoryPlaybookTarget = Extract<NugletLessonTarget, { schemaVersion: '1.1.0' }>;
export type NarrativeTarget = NugletNarrativeTarget;

export function calculateStoryPlaybookGenerationInputChecksum(
  semanticTarget: unknown,
  generationPlan: NugletGenerationPlan,
): string {
  return calculateNugletGenerationInputChecksum({
    semanticTarget: parseSemanticTarget(semanticTarget),
    generationPlan: nugletGenerationPlanSchema.parse(generationPlan),
  });
}

export function materializeStoryPlaybookTarget(input: {
  semanticTarget: unknown;
  generationPlan: NugletGenerationPlan;
  mediaArtifacts: NugletReviewMediaArtifacts;
  retainedMediaArtifactIds?: ReadonlySet<string>;
}): StoryPlaybookTarget {
  const semanticTarget = parseSemanticTarget(input.semanticTarget);
  const generationPlan = nugletGenerationPlanSchema.parse(input.generationPlan);
  const generationInputChecksum = calculateStoryPlaybookGenerationInputChecksum(semanticTarget, generationPlan);
  const hero = requiredMedia(input.mediaArtifacts, 'hero', generationInputChecksum, 'image/', input.retainedMediaArtifactIds);
  const infographic = requiredMedia(input.mediaArtifacts, 'infographic', generationInputChecksum, 'image/', input.retainedMediaArtifactIds);
  const audioBrief = requiredMedia(input.mediaArtifacts, 'audio_brief', generationInputChecksum, 'audio/', input.retainedMediaArtifactIds);
  const audioDiscussion = requiredMedia(input.mediaArtifacts, 'audio_discussion', generationInputChecksum, 'audio/', input.retainedMediaArtifactIds);

  if (audioBrief.id === audioDiscussion.id || audioBrief.checksum === audioDiscussion.checksum) {
    throw new TypeError('Brief and Discussion audio must be distinct immutable assets');
  }

  const heroMetadata = heroMetadataFor(hero, generationPlan);
  const infographicMetadata = imageMetadataFor(infographic, 'infographic');
  const briefMetadata = audioMetadataFor(audioBrief, 'audio_brief');
  const discussionMetadata = audioMetadataFor(audioDiscussion, 'audio_discussion');
  const target = {
    ...semanticTarget,
    payload: {
      ...semanticTarget.payload,
      materialization: 'materialized' as const,
      hero: {
        ...semanticTarget.payload.hero,
        asset: toArtifactReference(hero),
        width: heroMetadata.width,
        height: heroMetadata.height,
        focalPoint: heroMetadata.focalPoint,
        cropSafeArea: heroMetadata.cropSafeArea,
      },
      visual: {
        ...semanticTarget.payload.visual,
        asset: toArtifactReference(infographic),
        width: infographicMetadata.width,
        height: infographicMetadata.height,
      },
      listen: {
        brief: {
          ...semanticTarget.payload.listen.brief,
          asset: toArtifactReference(audioBrief),
          durationSeconds: briefMetadata.durationSeconds,
          transcript: transcriptFor(briefMetadata.transcript),
        },
        discussion: {
          ...semanticTarget.payload.listen.discussion,
          asset: toArtifactReference(audioDiscussion),
          durationSeconds: discussionMetadata.durationSeconds,
          transcript: transcriptFor(discussionMetadata.transcript),
        },
      },
    },
  };

  return knowledgeBitsContentSchema.parse({
    schemaVersion: 'knowledge-bits.content.v1',
    target,
  }).target as StoryPlaybookTarget;
}

export function calculateNarrativeGenerationInputChecksum(
  semanticTarget: unknown,
  generationPlan: NugletNarrativeGenerationPlan,
): string {
  return calculateNugletNarrativeGenerationInputChecksum({
    semanticTarget: parseNarrativeSemanticTarget(semanticTarget),
    generationPlan: nugletNarrativeGenerationPlanSchema.parse(generationPlan),
  });
}

export function materializeNarrativeTarget(input: {
  semanticTarget: unknown;
  generationPlan: NugletNarrativeGenerationPlan;
  mediaArtifacts: NugletReviewMediaArtifacts;
  retainedMediaArtifactIds?: ReadonlySet<string>;
}): NarrativeTarget {
  const semanticTarget = parseNarrativeSemanticTarget(input.semanticTarget);
  const generationPlan = nugletNarrativeGenerationPlanSchema.parse(input.generationPlan);
  const generationInputChecksum = calculateNarrativeGenerationInputChecksum(semanticTarget, generationPlan);
  const hero = requiredMedia(input.mediaArtifacts, 'hero', generationInputChecksum, 'image/', input.retainedMediaArtifactIds);
  const infographic = requiredMedia(input.mediaArtifacts, 'infographic', generationInputChecksum, 'image/', input.retainedMediaArtifactIds);
  const conversation = requiredMedia(input.mediaArtifacts, 'audio_conversation', generationInputChecksum, 'audio/', input.retainedMediaArtifactIds);
  const heroMetadata = heroMetadataFor(hero, generationPlan);
  const infographicMetadata = imageMetadataFor(infographic, 'infographic');
  const conversationMetadata = audioMetadataFor(conversation, 'audio_conversation');
  const target = {
    ...semanticTarget,
    payload: {
      ...semanticTarget.payload,
      materialization: 'materialized' as const,
      hero: {
        ...semanticTarget.payload.hero,
        asset: toArtifactReference(hero),
        width: heroMetadata.width,
        height: heroMetadata.height,
        focalPoint: heroMetadata.focalPoint,
        cropSafeArea: heroMetadata.cropSafeArea,
      },
      visual: {
        ...semanticTarget.payload.visual,
        asset: toArtifactReference(infographic),
        width: infographicMetadata.width,
        height: infographicMetadata.height,
      },
      listen: {
        conversation: {
          ...semanticTarget.payload.listen.conversation,
          asset: toArtifactReference(conversation),
          durationSeconds: conversationMetadata.durationSeconds,
          transcript: transcriptFor(conversationMetadata.transcript),
        },
      },
    },
  };
  return knowledgeBitsContentSchema.parse({
    schemaVersion: 'knowledge-bits.content.v1',
    target,
  }).target as NarrativeTarget;
}

function parseSemanticTarget(value: unknown): StoryPlaybookTarget & { payload: ReturnType<typeof storyPlaybookDraftSchema.parse> } {
  if (!isRecord(value)
    || value.kind !== 'nuglet.lesson.v1'
    || value.schemaVersion !== '1.1.0'
    || !('payload' in value)) {
    throw new TypeError('Story Playbook semantic target must be nuglet.lesson.v1 schema 1.1.0');
  }
  return {
    kind: 'nuglet.lesson.v1',
    schemaVersion: '1.1.0',
    payload: storyPlaybookDraftSchema.parse(value.payload),
  };
}

function parseNarrativeSemanticTarget(
  value: unknown,
): Extract<NarrativeTarget, { schemaVersion: '2.0.0' }> & {
  payload: ReturnType<typeof nugletNarrativeDraftSchema.parse>;
} {
  if (!isRecord(value)
    || value.kind !== 'nuglet.lesson.v2'
    || value.schemaVersion !== '2.0.0'
    || !('payload' in value)) {
    throw new TypeError('Narrative semantic target must be nuglet.lesson.v2 schema 2.0.0');
  }
  return {
    kind: 'nuglet.lesson.v2',
    schemaVersion: '2.0.0',
    payload: nugletNarrativeDraftSchema.parse(value.payload),
  };
}

function requiredMedia(
  artifacts: NugletReviewMediaArtifacts,
  kind: NugletReviewMediaKind,
  generationInputChecksum: string,
  mediaTypePrefix: string,
  retainedMediaArtifactIds?: ReadonlySet<string>,
): WorkflowArtifact {
  const artifact = artifacts[kind];
  if (!artifact) throw new TypeError(`Required ${kind} media asset is missing`);
  if (artifact.kind !== kind) throw new TypeError(`Required ${kind} media asset has the wrong role`);
  if (!artifact.mediaType.startsWith(mediaTypePrefix)) {
    throw new TypeError(`Required ${kind} media asset has an invalid media type`);
  }
  const isVerifiedLegacyReuse = artifact.provenance.mediaSource === 'legacy_nuglet';
  const isRetainedFromSourcePackage = retainedMediaArtifactIds?.has(artifact.id) ?? false;
  if (!isVerifiedLegacyReuse && !isRetainedFromSourcePackage && artifact.inputChecksum !== generationInputChecksum) {
    throw new TypeError(`Required ${kind} generation input checksum does not match the semantic draft`);
  }
  const measuredByteSize = positiveInteger(artifact.provenance.byteSize);
  if (measuredByteSize !== artifact.byteSize) {
    throw new TypeError(`Required ${kind} measured byte size does not match the immutable asset`);
  }
  return artifact;
}

function heroMetadataFor(
  artifact: WorkflowArtifact,
  generationPlan: NugletGenerationPlan | NugletNarrativeGenerationPlan,
) {
  const dimensions = imageMetadataFor(artifact, 'hero');
  const isLegacyReuse = artifact.provenance.mediaSource === 'legacy_nuglet';
  if (!isLegacyReuse
    && (dimensions.width < 1024 || dimensions.height < 768 || dimensions.width * 3 !== dimensions.height * 4)) {
    throw new TypeError('Hero dimensions must be 4:3 at a minimum of 1024 x 768');
  }
  if (!isLegacyReuse) {
    if (artifact.provenance.styleProfileChecksum !== generationPlan.recipes.hero.checksum) {
      throw new TypeError('Hero profile checksum does not match the approved hero profile');
    }
  }
  const focalPoint = normalizedPoint(artifact.provenance.focalPoint, 'Hero focal point');
  const cropSafeArea = normalizedCrop(artifact.provenance.cropSafeArea);
  return { ...dimensions, focalPoint, cropSafeArea };
}

function imageMetadataFor(artifact: WorkflowArtifact, label: string): { width: number; height: number } {
  const width = positiveInteger(artifact.provenance.width);
  const height = positiveInteger(artifact.provenance.height);
  if (!width || !height) throw new TypeError(`${label} measured dimensions are missing`);
  return { width, height };
}

function audioMetadataFor(artifact: WorkflowArtifact, label: string): { durationSeconds: number; transcript: string } {
  const durationSeconds = positiveNumber(artifact.provenance.durationSeconds);
  const transcript = typeof artifact.provenance.transcript === 'string'
    ? artifact.provenance.transcript.trim()
    : '';
  const transcriptSource = artifact.provenance.transcriptSource;
  if (!durationSeconds || !transcript) throw new TypeError(`${label} measured duration and final transcript are required`);
  if (transcriptSource !== 'notebooklm'
    && transcriptSource !== 'vertex_gemini'
    && transcriptSource !== 'legacy_nuglet') {
    throw new TypeError(`${label} transcript must be derived from final audio bytes`);
  }
  if (artifact.provenance.transcriptAudioChecksum !== `sha256:${artifact.checksum}`) {
    throw new TypeError(`${label} transcript audio checksum does not match the immutable audio asset`);
  }
  return { durationSeconds, transcript };
}

function transcriptFor(text: string) {
  return {
    source: 'final_audio_bytes' as const,
    text,
    checksum: createHash('sha256').update(Buffer.from(text)).digest('hex'),
  };
}

function normalizedPoint(value: unknown, label: string): { x: number; y: number } {
  if (!isRecord(value) || !normalizedNumber(value.x) || !normalizedNumber(value.y)) {
    throw new TypeError(`${label} metadata is missing or invalid`);
  }
  return { x: value.x, y: value.y };
}

function normalizedCrop(value: unknown): { x: number; y: number; width: number; height: number } {
  if (!isRecord(value)
    || !normalizedNumber(value.x)
    || !normalizedNumber(value.y)
    || !positiveNormalizedNumber(value.width)
    || !positiveNormalizedNumber(value.height)
    || value.x + value.width > 1
    || value.y + value.height > 1) {
    throw new TypeError('Hero crop safe area metadata is missing or invalid');
  }
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

function toArtifactReference(artifact: WorkflowArtifact): ArtifactReference {
  return artifactReferenceSchema.parse({
    artifactId: artifact.id,
    kind: artifact.kind,
    mediaType: artifact.mediaType,
    checksum: artifact.checksum,
    storageKey: artifact.storageKey,
    byteSize: artifact.byteSize,
    createdAt: artifact.createdAt.toISOString(),
    provider: typeof artifact.provenance.provider === 'string' && artifact.provenance.provider.trim()
      ? artifact.provenance.provider
      : 'unknown',
    inputChecksum: artifact.inputChecksum,
  });
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizedNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function positiveNormalizedNumber(value: unknown): value is number {
  return normalizedNumber(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
